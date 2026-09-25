import path from 'node:path';
import fs from 'node:fs';
import { paths, loadSource, loadCreator, readJson, readJsonOr, writeJson } from '../store.js';
import { loadPlaybook, playbookPromptBlock } from '../playbook/playbook.js';
import { log, step } from '../log.js';
import type { Sentence, Word, Candidate, Shot, FaceSample } from '../types.js';
import { windows, snapBounds, composite, dedupe, mergeFragmentedSentences, candidateId } from './snap.js';
import { proposeWindow } from './propose.js';
import { finalRank } from './rank.js';
import { checkBoundaries, applyBoundaryCheck } from './boundary.js';
import { visualMetrics, visualScore, visionCheck } from './visual.js';

const TOP_POOL = 20; // how many deduped candidates (by composite) get sent to the final-rank call

export type SelectOpts = { top?: number; force?: boolean };

function candidatesPath(sourceId: string): string {
  return path.join(paths.source(sourceId), 'candidates.json');
}

/**
 * Validates a raw LLM-proposed candidate's sentence-id range against the window it came
 * from. The transcript window text uses each sentence's own (global) id, so a candidate
 * whose ids fall outside [s0, s1] — or that isn't a well-formed non-empty range — means the
 * model referenced a sentence it wasn't shown, or hallucinated the range; drop it.
 */
function isValidRange(startSid: number, endSid: number, w: { s0: number; s1: number }): boolean {
  return (
    Number.isInteger(startSid) &&
    Number.isInteger(endSid) &&
    startSid >= w.s0 &&
    endSid <= w.s1 &&
    startSid <= endSid
  );
}

/** First/last `n` sentences of a (snapped) candidate's range, for a human sanity check of the cut. */
export function openingClosing(sentences: Sentence[], c: Candidate, n = 2): { opening: Sentence[]; closing: Sentence[] } {
  const opening = sentences.slice(c.startSid, c.startSid + n);
  const closing = sentences.slice(Math.max(c.startSid, c.endSid - n + 1), c.endSid + 1);
  return { opening, closing };
}

export async function selectSource(sourceId: string, o?: SelectOpts): Promise<Candidate[]> {
  const top = o?.top ?? 6;
  const outPath = candidatesPath(sourceId);

  if (!o?.force) {
    const existing = readJsonOr<Candidate[] | null>(outPath, null);
    if (existing) {
      log(`selectSource(${sourceId}): candidates.json already exists, skipping`);
      return existing;
    }
  }

  const dir = paths.source(sourceId);
  const source = loadSource(sourceId);
  const creator = loadCreator(source.creator);
  const sentences = readJson<Sentence[]>(path.join(dir, 'sentences.json'));
  const words = readJson<Word[]>(path.join(dir, 'words.json'));
  const pb = loadPlaybook(source.creator);
  const pbBlock = playbookPromptBlock(pb);
  const { min: minSec, max: maxSec } = pb.idealDurationSec;

  const ws = windows(sentences);
  const propCtx = { creatorName: creator.name, title: source.title, pbBlock, minSec, maxSec };

  const done = step(`selectSource ${sourceId}: proposing over ${ws.length} window(s)`);
  const rawPerWindow = await Promise.all(ws.map((w) => proposeWindow(propCtx, sentences, w)));
  done();

  const candidates: Candidate[] = [];
  let dropped = 0;
  for (let wi = 0; wi < ws.length; wi++) {
    const w = ws[wi];
    for (const raw of rawPerWindow[wi]) {
      if (!isValidRange(raw.startSid, raw.endSid, w)) {
        dropped++;
        continue;
      }
      // A candidate landing on a sentence-splitter fragment (buildSentences force-split a
      // run-on utterance mid-sentence) would otherwise start mid-thought or cut its payoff
      // short — absorb the fragment before snapping. This can move outside [w.s0, w.s1]; that's
      // fine, it's a deterministic local correction, not a fresh (unvalidated) model guess.
      const { startSid, endSid } = mergeFragmentedSentences(sentences, raw.startSid, raw.endSid);
      const snapped = snapBounds(sentences, words, startSid, endSid);
      const durationSec = snapped.end - snapped.start;
      if (durationSec < minSec * 0.85 || durationSec > maxSec * 1.15) {
        dropped++;
        continue;
      }
      candidates.push({
        id: candidateId(sourceId, startSid, endSid),
        sourceId,
        startSid,
        endSid,
        start: snapped.start,
        end: snapped.end,
        title: raw.title,
        summary: raw.summary,
        why: raw.why,
        patterns: raw.patterns,
        scores: raw.scores,
        composite: composite(raw.scores, pb.weights),
        shortlisted: false,
      });
    }
  }
  log(`selectSource ${sourceId}: ${candidates.length} valid candidates (${dropped} dropped: out-of-window ids or bad duration)`);

  const deduped = dedupe(candidates);
  log(`selectSource ${sourceId}: ${deduped.length} after dedupe`);

  const byComposite = [...deduped].sort((a, b) => b.composite - a.composite);
  const pool = byComposite.slice(0, TOP_POOL);
  const rest = byComposite.slice(TOP_POOL);

  // Focused verifier: for the top candidates only, an independent (cheap, fast-tier) LLM call
  // checks whether the opening truly stands alone and the ending truly lands the payoff —
  // catching what the proposer itself missed, rather than relying solely on better proposer
  // prompting. Repairs shift startSid/endSid within a small window when that keeps the clip's
  // duration in bounds; otherwise the relevant score is penalized so a still-broken clip ranks
  // lower instead of silently shipping.
  const boundsForCheck = { minSec, maxSec, weights: pb.weights };
  const checks = await Promise.all(pool.map((c) => checkBoundaries(c, sentences, { minSec, maxSec })));
  const checkedPool = pool.map((c, i) => applyBoundaryCheck(c, checks[i], sentences, words, boundsForCheck));
  const repairedCount = checkedPool.filter((c) => c.boundary?.repaired).length;
  const penalizedCount = checkedPool.filter((c) => c.boundary && !c.boundary.repaired && (!c.boundary.openingStandalone || !c.boundary.endingComplete)).length;
  log(`selectSource ${sourceId}: boundary check repaired ${repairedCount}/${checkedPool.length}, penalized ${penalizedCount}/${checkedPool.length}`);

  // A repair can move two different candidates onto the identical [startSid, endSid] — since
  // candidateId is deterministic, they'd then carry the same id (a collision dedupe run only
  // BEFORE repairs can't catch, because it never saw the post-repair ranges). Re-dedupe the
  // checked pool together with the untouched rest: identical ranges have IoU 1, so dedupe keeps
  // only the higher-composite one. Re-slice into a (possibly smaller) top-TOP_POOL pool for
  // finalRank and everything else as "rest", same convention as the first pool/rest split above.
  const dedupedAfterCheck = dedupe([...checkedPool, ...rest]);
  const finalPool = dedupedAfterCheck.slice(0, TOP_POOL);

  // Visual fitness: a clip can be strong on paper (transcript-only scores) and bad on screen —
  // no visible subject, nothing to crop tight on, jittery cuts, or a slide/ad burned into the
  // frame. For the top pool only (this is where the vision LLM calls live, kept cheap by being
  // scoped to a handful of finalists rather than every proposed candidate), combine the source's
  // shot/face scan (metrics, pure/free) with a focused per-candidate keyframe vision check
  // (LLM, tier `fast`) and fold the result into candidate.visual + a composite penalty.
  const shots = readJsonOr<Shot[]>(path.join(dir, 'shots.json'), []);
  const faces = readJsonOr<FaceSample[]>(path.join(dir, 'faces.json'), []);
  const srcAspect = source.width / source.height;
  const framesDir = path.join(dir, 'frames');

  const doneVisual = step(`selectSource ${sourceId}: visual fitness check on ${finalPool.length} candidate(s)`);
  await Promise.all(
    finalPool.map(async (c) => {
      const metrics = visualMetrics(c.start, c.end, shots, faces, srcAspect);
      const { score: metricScore, issues: metricIssues } = visualScore(metrics);

      let visionIssues: string[] = [];
      try {
        const vision = await visionCheck(c, framesDir);
        visionIssues = vision.issues;
      } catch (err) {
        log(`selectSource ${sourceId}: visionCheck failed for ${c.id}, treating as no vision issues: ${err instanceof Error ? err.message : String(err)}`);
      }
      const visionDeduction = Math.min(3, visionIssues.length);
      const score = Math.max(0, Math.min(10, metricScore - visionDeduction));

      c.visual = { score, metrics, issues: [...metricIssues, ...visionIssues] };
      if (score < 5) {
        c.composite = Math.round((c.composite - (5 - score) * 0.4) * 100) / 100;
      }
    }),
  );
  doneVisual();

  const ranking = await finalRank(finalPool, sentences, creator.name, pbBlock, top);

  const rankById = new Map(ranking.map((r, i) => [r.id, { rank: i + 1, reason: r.reason }]));
  for (const c of dedupedAfterCheck) {
    const r = rankById.get(c.id);
    if (r) {
      c.rank = r.rank;
      c.rankReason = r.reason;
      c.shortlisted = true;
    }
  }

  const sorted = [...dedupedAfterCheck].sort((a, b) => {
    if (a.shortlisted && b.shortlisted) return (a.rank ?? 0) - (b.rank ?? 0);
    if (a.shortlisted) return -1;
    if (b.shortlisted) return 1;
    return b.composite - a.composite;
  });

  const seenIds = new Set<string>();
  for (const c of sorted) {
    if (seenIds.has(c.id)) {
      throw new Error(`selectSource ${sourceId}: duplicate candidate id ${c.id} survived dedupe — refusing to write candidates.json`);
    }
    seenIds.add(c.id);
  }

  fs.mkdirSync(dir, { recursive: true });
  writeJson(outPath, sorted);
  log(`selectSource ${sourceId}: shortlisted ${sorted.filter((c) => c.shortlisted).length}/${sorted.length}`);
  return sorted;
}

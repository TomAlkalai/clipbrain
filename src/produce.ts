import path from 'node:path';
import { DATA } from './config.js';
import { paths, loadSource, loadCreator, readJson, readJsonOr, saveClip, loadClip, listClips, listDirs, newId } from './store.js';
import { ensureHires, renderClip } from './render/render.js';
import { buildEdl } from './edit/edl.js';
import { qcClip } from './qc/qc.js';
import { generateHooks, type GeneratedHooks } from './hooks/hooks.js';
import { loadPlaybook } from './playbook/playbook.js';
import { ingest } from './ingest.js';
import { analyzeSource } from './analyze/analyze.js';
import { selectSource } from './select/select.js';
import { listChannel } from './yt/ytdlp.js';
import { mmss } from './select/propose.js';
import { ledgerSummary } from './llm/llm.js';
import { log, step } from './log.js';
import type { Clip, Word, Shot, FaceSample, Source, Creator, Candidate, Sentence, RefShort } from './types.js';

// Task 14: hooks -> edl -> render -> qc orchestration for shortlisted candidates, plus the
// run/eval/scout entry points. `rebuildEdl` (below) predates this — it was needed by Task 13's
// QC auto-fix loop (see controller ruling R3 in task-13-brief.md) — and is left as-is.

/**
 * `"\n\nFrom \"<source.title>\" — <creator.name>\nFull episode: <source.url or ''>"` — appended
 * to every clip's LLM-generated description so viewers can find and credit the source episode.
 * Pure.
 */
export function attribution(source: Source, creator: Creator): string {
  return `\n\nFrom "${source.title}" — ${creator.name}\nFull episode: ${source.url ?? ''}`;
}

/**
 * Builds a freshly-planned (status `planned`) Clip from a shortlisted candidate and its
 * generated hooks — the first step of `produceSource`, before any hi-res fetch/EDL/render/QC
 * has happened. `renders` starts at 0 and `hookIndex` at 0 (the best-scored hook, since
 * `generateHooks`/`sortHooks` already sorted them descending). `coldOpen` is derived from
 * `gen.coldOpenSid` (already validated by `generateHooks`/`validateColdOpen`): the sentence's
 * own span padded -0.1s/+0.2s, or null when there is no cold open. `rank`/`why`/`visual`/
 * `boundary` are copied over from the candidate for the review UI (rendered defensively there).
 * Pure — no I/O, no id/clock inputs beyond `newId`/`Date.now` (same convention as other
 * id-minting constructors in this codebase, e.g. `select/snap.ts`'s `candidateId`).
 */
export function planClip(source: Source, creator: Creator, cand: Candidate, gen: GeneratedHooks, sentences: Sentence[]): Clip {
  const now = new Date().toISOString();
  const coldOpen =
    gen.coldOpenSid !== null
      ? { start: sentences[gen.coldOpenSid].start - 0.1, end: sentences[gen.coldOpenSid].end + 0.2 }
      : null;

  return {
    id: newId('clip'),
    sourceId: source.id,
    creator: source.creator,
    candidateId: cand.id,
    start: cand.start,
    end: cand.end,
    coldOpen,
    title: gen.title,
    description: gen.description + attribution(source, creator),
    hashtags: gen.hashtags,
    hooks: gen.hooks,
    hookIndex: 0,
    scores: cand.scores,
    composite: cand.composite,
    rankReason: cand.rankReason ?? '',
    patterns: cand.patterns,
    hiresOffset: 0,
    status: 'planned',
    renders: 0,
    createdAt: now,
    updatedAt: now,
    rank: cand.rank,
    why: cand.why,
    visual: cand.visual,
    boundary: cand.boundary,
  };
}

/**
 * Rebuilds a clip's EDL from its source's already-analyzed words/shots/faces, re-fetching hi-res
 * coverage first (`ensureHires`) in case `start`/`end`/`coldOpen` moved since the hi-res window
 * was last fetched. Used both by the initial hooks->edl step (future Task 14) and by QC's
 * auto-fix loop (Task 13), which mutates `clip.start`/`clip.end`/`clip.hookIndex` and then calls
 * this to regenerate the EDL to match before re-rendering.
 *
 * `overrides.maxPause` is forwarded to `buildEdl`'s own `opts.maxPause` (the dead_air fix loosens
 * pause-tightening). `overrides.fitSegments` replaces the *already-built* EDL's layout at those
 * segment indices with `{ kind: 'fit' }` (the framing / vision fit_layout fixes) — applied after
 * `buildEdl` runs, not fed into it, since `buildEdl` has no per-segment layout override of its own.
 */
export async function rebuildEdl(clip: Clip, overrides?: { maxPause?: number; fitSegments?: number[] }): Promise<void> {
  const source = loadSource(clip.sourceId);
  const creator = loadCreator(clip.creator);
  const dir = paths.source(clip.sourceId);
  const words = readJson<Word[]>(path.join(dir, 'words.json'));
  const shots = readJson<Shot[]>(path.join(dir, 'shots.json'));
  const faces = readJson<FaceSample[]>(path.join(dir, 'faces.json'));

  await ensureHires(clip, source);

  const hook = clip.hooks[clip.hookIndex]?.text ?? null;
  const edl = buildEdl({
    start: clip.start,
    end: clip.end,
    coldOpen: clip.coldOpen,
    words,
    shots,
    faces,
    srcAspect: source.width / source.height,
    hiresOffset: clip.hiresOffset,
    videoSrc: 'hires.mp4',
    hook,
    style: clip.style ?? 'default',
    override: creator.layoutOverride,
    ...(overrides?.maxPause !== undefined ? { opts: { maxPause: overrides.maxPause } } : {}),
  });

  if (overrides?.fitSegments) {
    for (const idx of overrides.fitSegments) {
      if (edl.segments[idx]) edl.segments[idx] = { ...edl.segments[idx], layout: { kind: 'fit' } };
    }
  }

  clip.edl = edl;
  saveClip(clip);
}

/**
 * For each shortlisted candidate (by rank) that doesn't already have a clip — matched by
 * `candidateId` against every existing clip for this source, regardless of status, so a re-run
 * after a partial failure never re-produces a clip that already exists — runs: hooks -> planClip
 * -> save -> ensureHires -> rebuildEdl -> renderClip -> qcClip. Sequential, not parallel:
 * rendering is CPU-bound (Remotion + ffmpeg), so producing candidates concurrently would just
 * contend for the same cores rather than finishing faster.
 *
 * Each clip is processed in its own try/catch: on error, the clip (if `planClip` already ran)
 * gets `clip.error = message` and is saved as-is, and the loop continues to the next candidate
 * rather than aborting the whole run. `o.limit`, when given, caps how many *new* clips this call
 * produces (candidates already skipped for having a clip don't count against it).
 */
export async function produceSource(sourceId: string, o?: { limit?: number }): Promise<Clip[]> {
  const dir = paths.source(sourceId);
  const source = loadSource(sourceId);
  const creator = loadCreator(source.creator);
  const pb = loadPlaybook(source.creator);
  const sentences = readJson<Sentence[]>(path.join(dir, 'sentences.json'));
  const candidates = readJson<Candidate[]>(path.join(dir, 'candidates.json'));
  const shortlisted = candidates.filter((c) => c.shortlisted).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));

  const existingCandidateIds = new Set(listClips((c) => c.sourceId === sourceId).map((c) => c.candidateId));

  const results: Clip[] = [];
  let produced = 0;
  for (const cand of shortlisted) {
    if (existingCandidateIds.has(cand.id)) continue;
    if (o?.limit !== undefined && produced >= o.limit) break;
    produced++;

    let clip: Clip | undefined;
    try {
      const gen = await generateHooks({
        creatorName: creator.name,
        episodeTitle: source.title,
        pb,
        sentences,
        startSid: cand.startSid,
        endSid: cand.endSid,
        candidateTitle: cand.title,
        summary: cand.summary,
      });
      clip = planClip(source, creator, cand, gen, sentences);
      saveClip(clip);

      const doneHires = step(`produceSource ${sourceId}: ensureHires (${clip.id}, rank ${cand.rank})`);
      await ensureHires(clip, source);
      doneHires();

      await rebuildEdl(clip);

      const doneRender = step(`produceSource ${sourceId}: render (${clip.id})`);
      await renderClip(clip.id);
      doneRender();

      const doneQc = step(`produceSource ${sourceId}: qc (${clip.id})`);
      await qcClip(clip.id);
      doneQc();

      results.push(loadClip(clip.id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`produceSource ${sourceId}: candidate ${cand.id} (rank ${cand.rank}) failed: ${message}`);
      if (clip) {
        clip.error = message;
        saveClip(clip);
        results.push(loadClip(clip.id));
      }
    }
  }
  return results;
}

/**
 * Full pipeline for one input: ingest -> analyzeSource -> selectSource -> produceSource. Prints a
 * summary table (clip id, status, source window, duration, composite, hook) and the ledger cost
 * delta incurred by this call (ingest/analyze/select/produce can all make LLM calls), then a
 * pointer to the review UI.
 */
export async function runPipeline(input: string, creator: string, o: { top: number }): Promise<void> {
  const before = ledgerSummary();

  const source = await ingest(input, creator);
  await analyzeSource(source.id);
  await selectSource(source.id, { top: o.top });
  const clips = await produceSource(source.id);

  const after = ledgerSummary();
  const deltaUsd = after.costUsd - before.costUsd;

  console.log(`\n${source.id} — ${source.title}`);
  console.log(
    'id'.padEnd(14),
    'status'.padEnd(11),
    'window'.padEnd(20),
    'dur'.padEnd(8),
    'composite'.padEnd(10),
    'hook',
  );
  for (const c of clips) {
    const window = `${mmss(c.start)}–${mmss(c.end)}`;
    const dur = c.edl ? `${c.edl.durationSec.toFixed(1)}s` : '-';
    const hook = c.error ? `ERROR: ${c.error}` : c.hooks[c.hookIndex]?.text ?? '(no hook)';
    console.log(
      c.id.padEnd(14),
      c.status.padEnd(11),
      window.padEnd(20),
      dur.padEnd(8),
      c.composite.toFixed(2).padEnd(10),
      hook,
    );
  }
  console.log(`\nledger cost this run: $${deltaUsd.toFixed(4)}`);
  console.log('\nReview: npx tsx src/cli.ts review');
}

/**
 * Pure filter for `scout`: keeps episodes at least `minDur` seconds long (default 900s = 15min,
 * so YouTube Shorts and short clips already on the channel don't come back as "episodes") whose
 * videoId isn't already in `existingVideoIds`, then takes the first `latest`. The input list is
 * assumed to already be newest-first (yt-dlp's channel "videos" tab listing order), so this does
 * no independent re-sort.
 */
export function pickNewEpisodes(list: RefShort[], existingVideoIds: Set<string>, latest: number, minDur = 900): RefShort[] {
  return list.filter((e) => e.durationSec >= minDur && !existingVideoIds.has(e.id)).slice(0, latest);
}

function existingVideoIdsForCreator(slug: string): Set<string> {
  const dir = path.join(DATA, 'sources');
  const ids = new Set<string>();
  for (const id of listDirs(dir)) {
    const s = readJsonOr<Source | null>(path.join(paths.source(id), 'source.json'), null);
    if (s && s.creator === slug && s.kind === 'youtube' && s.videoId) ids.add(s.videoId);
  }
  return ids;
}

/**
 * Automatic episode discovery (Task 14 extension): lists a creator's newest long-form episodes
 * (the `videos` tab, over-fetching `latest x 3` so there's headroom left after filtering) and
 * returns up to `latest` video URLs — newest first — that are long enough to be episodes (not
 * Shorts) and don't already have a source ingested for that videoId.
 */
export async function scout(slug: string, o?: { latest?: number; minDurationSec?: number }): Promise<string[]> {
  const latest = o?.latest ?? 3;
  const minDurationSec = o?.minDurationSec ?? 900;
  const creator = loadCreator(slug);
  const list = await listChannel(creator.channelUrl, 'videos', latest * 3);
  const existing = existingVideoIdsForCreator(slug);
  const picked = pickNewEpisodes(list, existing, latest, minDurationSec);
  return picked.map((e) => `https://www.youtube.com/watch?v=${e.id}`);
}

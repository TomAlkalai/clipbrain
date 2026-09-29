import path from 'node:path';
import { paths, loadSource, readJsonOr } from './store.js';
import { mmss } from './select/propose.js';
import type { Alignment, Candidate, ShortFeatures } from './types.js';

export type EvalRow = {
  shortId: string;
  title: string;
  perf: number;
  srcStart: number;
  srcEnd: number;
  matchedCandidate: string | null;
  shortlisted: boolean;
};

export type EvalResult = {
  official: number;
  recall: number;
  precision: number;
  rows: EvalRow[];
};

const OVERLAP_THRESHOLD = 0.3;

/** Official moment's source span: min srcStart .. max srcEnd across its aligned segments. Pure. */
export function officialSpan(a: Alignment): { srcStart: number; srcEnd: number } {
  const starts = a.segments.map((s) => s.srcStart);
  const ends = a.segments.map((s) => s.srcEnd);
  return { srcStart: Math.min(...starts), srcEnd: Math.max(...ends) };
}

/**
 * Fraction of an official moment's span [srcStart, srcEnd] that a candidate's [start, end]
 * covers — temporal overlap / official span length. A candidate "matches" the official moment
 * when this is >= OVERLAP_THRESHOLD (0.3). Pure.
 */
export function overlapRatio(candStart: number, candEnd: number, srcStart: number, srcEnd: number): number {
  const span = srcEnd - srcStart;
  if (span <= 0) return 0;
  const overlap = Math.max(0, Math.min(candEnd, srcEnd) - Math.max(candStart, srcStart));
  return overlap / span;
}

/** True if any candidate's window overlaps the official moment's span by >= 0.3 of that span. Pure. */
function findMatch(candidates: Candidate[], srcStart: number, srcEnd: number): Candidate | null {
  let best: Candidate | null = null;
  let bestRatio = 0;
  for (const c of candidates) {
    const ratio = overlapRatio(c.start, c.end, srcStart, srcEnd);
    if (ratio >= OVERLAP_THRESHOLD && ratio > bestRatio) {
      best = c;
      bestRatio = ratio;
    }
  }
  return best;
}

/**
 * Compares this source's shortlisted (and unshortlisted) candidates against the creator's
 * official Shorts mined from the *same* episode (`data/creators/<slug>/alignments.json`,
 * filtered to `episodeId === source.videoId`). Each official moment's span is the min/max of its
 * aligned segments' source timestamps; a candidate "matches" it when their temporal overlap is
 * at least 30% of the official moment's span.
 *
 * `recall` is computed against *all* mined candidates (not just shortlisted ones) — it answers
 * "did candidate generation even surface something near what the creator's own team picked?".
 * `precision` is computed against only the *shortlisted* candidates — it answers "of what we
 * actually chose to produce, how much lines up with an official pick?". These are deliberately
 * different denominators/pools, not two views of the same computation.
 *
 * When there are no official Shorts for this episode (common — the creator's mined Shorts
 * usually only cover a fraction of their catalog), prints a clear explanation and a suggested
 * remedy, and returns a zeroed result rather than a misleading 0%/0%.
 */
export async function evalSource(sourceId: string): Promise<EvalResult> {
  const source = loadSource(sourceId);
  const alignments = readJsonOr<Alignment[]>(path.join(paths.creator(source.creator), 'alignments.json'), []);
  const official = alignments.filter((a) => a.episodeId === source.videoId);

  const candidates = readJsonOr<Candidate[]>(path.join(paths.source(sourceId), 'candidates.json'), []);

  if (official.length === 0) {
    const episodesCovered = new Set(alignments.map((a) => a.episodeId)).size;
    console.log(
      `eval ${sourceId}: no official Shorts found for episode ${source.videoId ?? '(no videoId)'} ("${source.title}") ` +
        `among the ${alignments.length} mined alignment(s) for creator "${source.creator}" (which cover ${episodesCovered} ` +
        `other episode(s)). This is expected when the creator hasn't clipped this specific episode yet, or when it ` +
        `wasn't among the Shorts mined so far — it is NOT a failure of selection/produce.`,
    );
    console.log(
      `Suggested remedy: run \`npx tsx src/cli.ts mine ${source.creator} --shorts 200 --episodes 120\` to mine more ` +
        `of the channel's Shorts (raising the odds one aligns to this episode), or pass ` +
        `\`--include <shortId,...>\` to \`mine\` if you already know which of the creator's Shorts came from it.`,
    );
    console.log("Caveat: Official shorts are one team's picks, not ground truth.");
    return { official: 0, recall: 0, precision: 0, rows: [] };
  }

  const features = readJsonOr<ShortFeatures[]>(path.join(paths.creator(source.creator), 'features.json'), []);
  const featureById = new Map(features.map((f) => [f.shortId, f]));

  const rows: EvalRow[] = [];
  let matchedCount = 0;
  for (const a of official) {
    const { srcStart, srcEnd } = officialSpan(a);
    const match = findMatch(candidates, srcStart, srcEnd);
    if (match) matchedCount++;
    const f = featureById.get(a.shortId);
    rows.push({
      shortId: a.shortId,
      title: f?.title ?? '(title unknown — not in features.json)',
      perf: f?.perf ?? 0,
      srcStart,
      srcEnd,
      matchedCandidate: match?.id ?? null,
      shortlisted: match?.shortlisted ?? false,
    });
  }
  const recall = matchedCount / official.length;

  const shortlistedCandidates = candidates.filter((c) => c.shortlisted);
  const shortlistedHits = shortlistedCandidates.filter((c) =>
    official.some((a) => {
      const { srcStart, srcEnd } = officialSpan(a);
      return overlapRatio(c.start, c.end, srcStart, srcEnd) >= OVERLAP_THRESHOLD;
    }),
  ).length;
  const precision = shortlistedCandidates.length > 0 ? shortlistedHits / shortlistedCandidates.length : 0;

  console.log(`eval ${sourceId}: ${official.length} official short(s) mined from this episode ("${source.title}")\n`);
  console.log(
    'shortId'.padEnd(14),
    'perf'.padEnd(7),
    'span'.padEnd(16),
    'matched'.padEnd(12),
    'shortlisted'.padEnd(12),
    'title',
  );
  for (const r of rows) {
    const span = `${mmss(r.srcStart)}-${mmss(r.srcEnd)}`;
    console.log(
      r.shortId.padEnd(14),
      r.perf.toFixed(2).padEnd(7),
      span.padEnd(16),
      (r.matchedCandidate ?? '-').padEnd(12),
      String(r.shortlisted).padEnd(12),
      r.title.slice(0, 60),
    );
  }
  console.log(
    `\nrecall=${(recall * 100).toFixed(0)}% (${matchedCount}/${official.length} official moments matched by some ` +
      `mined candidate)  precision=${(precision * 100).toFixed(0)}% (${shortlistedHits}/${shortlistedCandidates.length} ` +
      `shortlisted candidates overlap an official moment)`,
  );
  console.log("Caveat: Official shorts are one team's picks, not ground truth.");

  return { official: official.length, recall, precision, rows };
}

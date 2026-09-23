import type { Sentence, Word, Scores, SignalName, Candidate } from '../types.js';
import { SIGNALS } from '../types.js';

/**
 * Splits `sentences` into overlapping windows of ~`windowSec` seconds (measured
 * from each window's first sentence start to its last sentence start), stepping
 * forward by `windowSec - overlapSec` each time. Returns inclusive sentence
 * index ranges [s0, s1] that together cover every sentence, with consecutive
 * windows overlapping by roughly `overlapSec` seconds so a clip near a window
 * boundary is never missed. Pure.
 */
export function windows(sentences: Sentence[], windowSec = 1200, overlapSec = 90): { s0: number; s1: number }[] {
  const n = sentences.length;
  if (n === 0) return [];
  const step = windowSec - overlapSec;
  const result: { s0: number; s1: number }[] = [];
  let s0 = 0;
  while (true) {
    const winStart = sentences[s0].start;
    let s1 = s0;
    while (s1 + 1 < n && sentences[s1 + 1].start < winStart + windowSec) s1++;
    result.push({ s0, s1 });
    if (s1 === n - 1) break;

    const nextStart = winStart + step;
    let nextS0 = s0;
    while (nextS0 < n - 1 && sentences[nextS0].start < nextStart) nextS0++;
    s0 = nextS0 > s0 ? nextS0 : s0 + 1; // guarantee forward progress
  }
  return result;
}

export type Pad = { start: number; end: number };

/**
 * Snaps a [startSid, endSid] sentence range to actual clip boundaries: pads a
 * little before the first sentence and a little after the last (for breathing
 * room), but never crosses into the neighbouring sentence's words. Pure.
 */
export function snapBounds(
  sentences: Sentence[],
  words: Word[],
  startSid: number,
  endSid: number,
  pad: Pad = { start: 0.12, end: 0.3 },
): { start: number; end: number } {
  const first = sentences[startSid];
  const last = sentences[endSid];

  const wordBefore = first.w0 > 0 ? words[first.w0 - 1] : undefined;
  const start = Math.max(first.start - pad.start, wordBefore ? wordBefore.end + 0.02 : -Infinity, 0);

  const wordAfter = last.w1 < words.length - 1 ? words[last.w1 + 1] : undefined;
  const end = Math.min(last.end + pad.end, wordAfter ? wordAfter.start - 0.02 : Infinity);

  return { start, end };
}

// Mirrors text/sentences.ts's own end-punctuation check: a sentence lacking this was not
// closed by real punctuation, which buildSentences only does when it force-split a run-on
// utterance (hit its word cap, or a silence gap) mid-sentence — the "sentence" is a fragment
// that continues into the next one.
const END_PUNCT_RE = /[.?!]["')]?\s*$/;
const FRAGMENT_MERGE_CAP = 3; // how many extra fragment sentences we'll absorb on either side

/**
 * Grows [startSid, endSid] to absorb adjacent sentence-splitter fragments, so a candidate
 * never starts on the tail-end of a forced split (e.g. "...of time.") or ends on its
 * unpunctuated head (e.g. "...for a very long period"), which would otherwise read as a
 * mid-thought start or a payoff cut off before it lands. Bounded by `FRAGMENT_MERGE_CAP` so a
 * genuinely punctuation-free run of speech can't runaway-absorb the whole transcript. Pure.
 */
export function mergeFragmentedSentences(sentences: Sentence[], startSid: number, endSid: number): { startSid: number; endSid: number } {
  let start = startSid;
  const startFloor = Math.max(0, start - FRAGMENT_MERGE_CAP);
  while (start > startFloor && !END_PUNCT_RE.test(sentences[start - 1].text)) start--;

  let end = endSid;
  const endCeil = Math.min(sentences.length - 1, end + FRAGMENT_MERGE_CAP);
  while (end < endCeil && !END_PUNCT_RE.test(sentences[end].text)) end++;

  return { startSid: start, endSid: end };
}

/** Weighted mean of the 7 signal scores, rounded to 2 decimals. Pure. */
export function composite(scores: Scores, weights: Record<SignalName, number>): number {
  let sum = 0;
  let wsum = 0;
  for (const s of SIGNALS) {
    const w = weights[s] ?? 0;
    sum += scores[s].score * w;
    wsum += w;
  }
  const mean = wsum > 0 ? sum / wsum : 0;
  return Math.round(mean * 100) / 100;
}

function iou(a: { start: number; end: number }, b: { start: number; end: number }): number {
  const overlap = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  if (overlap === 0) return 0;
  const union = Math.max(a.end, b.end) - Math.min(a.start, b.start);
  return union > 0 ? overlap / union : 0;
}

/**
 * Sorts candidates by composite score descending, then drops any candidate
 * whose temporal IoU with an already-kept (higher-composite) candidate is
 * >= `iou`. Pure.
 */
export function dedupe(c: Candidate[], iouThreshold = 0.5): Candidate[] {
  const sorted = [...c].sort((a, b) => b.composite - a.composite);
  const kept: Candidate[] = [];
  for (const cand of sorted) {
    if (kept.some((k) => iou(k, cand) >= iouThreshold)) continue;
    kept.push(cand);
  }
  return kept;
}

import type { Edl, EdlCaption, EdlSegment, FaceSample, Layout, Shot, Silence, Word } from '../types.js';
import { planLayout } from './crop.js';

export type EdlInput = {
  start: number;
  end: number;
  coldOpen: { start: number; end: number } | null;
  words: Word[];
  shots: Shot[];
  faces: FaceSample[];
  srcAspect: number;
  hiresOffset: number;
  videoSrc: string;
  hook: string | null;
  style: string;
  override?: Layout;
  /** Audio silences detected by ffmpeg silencedetect (data/sources/<id>/silences.json), source
   * seconds. Root-cause fix (2026-09-26, debug-dead-air.md): whisper.cpp word timings can smear
   * across a real silence with ~0 gap between adjacent words, so the word-gap cutter alone never
   * sees it — this independent signal catches it. Optional/omittable so every existing caller and
   * test keeps working unchanged when it isn't supplied (treated as no silence data, `[]`). */
  silences?: Silence[];
  opts?: { maxPause?: number; keepPause?: number; minSeg?: number; hookSec?: number };
};

type Range = { start: number; end: number };
type Piece = { start: number; end: number };
type TimedWord = Word & { outStart: number; outEnd: number };

const EDGE_GUARD = 0.3; // a shot cut must be this far from either edge of a run to be honoured
const PAGE_MAX_WORDS = 3;
const PAGE_END_PAD = 0.4; // extra tail shown after the last word of a caption page
const PAGE_GAP_BREAK = 0.3; // source-time gap that forces a caption page break
const END_PUNCT_RE = /[.?!,]$/;

// Millisecond rounding applied only to final output numbers, to erase the binary-float noise
// that accumulates from chained +/- on decimal inputs (e.g. 10.975 - 9.9 !== 1.075 exactly) —
// without this, values that are conceptually exact (e.g. a 2.55s hook end) come out as
// 2.549999999999999 and fail exact-equality checks downstream (e.g. in the Remotion renderer's
// own equality/caching). Internal comparisons (edge guards, minSeg, etc.) use raw floats, since
// their tolerances are far larger than this noise.
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * Merges overlapping/touching intervals (sorted ascending by start) into their union. Pure.
 */
function mergeIntervals(intervals: Range[]): Range[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Range[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur.start <= last.end) {
      if (cur.end > last.end) last.end = cur.end;
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

/**
 * Splits `range` into kept pieces around a set of (already merged, ascending) cut intervals,
 * keeping `keepHalf` of pause on each side of every cut — the piece before a cut ends at
 * `cut.start + keepHalf`, the piece after starts at `cut.end - keepHalf`. The very first piece
 * starts at `range.start` and the very last ends at `range.end`, never at a cut's own timing, so
 * a range boundary never clips inward. Pure.
 */
function piecesFromCuts(range: Range, cuts: Range[], keepHalf: number): Piece[] {
  const pieces: Piece[] = [];
  let cur = range.start;
  for (const cut of cuts) {
    const cutStart = Math.max(cut.start, range.start);
    const cutEnd = Math.min(cut.end, range.end);
    if (cutEnd <= cur) continue;
    const pieceEnd = Math.min(Math.max(cutStart + keepHalf, cur), range.end);
    if (pieceEnd > cur) pieces.push({ start: cur, end: pieceEnd });
    cur = Math.max(Math.min(cutEnd - keepHalf, range.end), pieceEnd);
  }
  if (cur < range.end) pieces.push({ start: cur, end: range.end });
  return pieces;
}

/**
 * Splits a range's fully-contained words into speech runs, cutting wherever either signal says
 * there's a long pause — this is the "tighten long pauses" step:
 *   - a word-gap cut: the gap between consecutive (fully-contained) words exceeds `maxPause`;
 *   - a silence cut (root-cause fix, 2026-09-26): an entry in `silences` overlapping this range
 *     whose own duration exceeds `maxPause`. whisper.cpp word timings can smear across a real
 *     silence with ~0 gap between adjacent words — see debug-dead-air.md — so this independent,
 *     ffmpeg-detected signal catches what the word-gap check alone misses.
 * The two cut sources are merged (overlapping cuts coalesced) before being applied, so a pause
 * flagged by both signals isn't double-cut. `keepHalf` (keepPause/2) of silence is kept on each
 * side of every cut for breathing room. Pure.
 */
function speechRuns(range: Range, words: Word[], maxPause: number, keepHalf: number, silences: Silence[]): Piece[] {
  const inRange = words.filter((w) => w.start >= range.start && w.end <= range.end).sort((a, b) => a.start - b.start);
  if (inRange.length === 0) return [];

  const wordCuts: Range[] = [];
  for (let i = 1; i < inRange.length; i++) {
    if (inRange[i].start - inRange[i - 1].end > maxPause) {
      wordCuts.push({ start: inRange[i - 1].end, end: inRange[i].start });
    }
  }

  const silenceCuts: Range[] = silences
    .filter((s) => s.end - s.start > maxPause && s.end > range.start && s.start < range.end)
    .map((s) => ({ start: Math.max(s.start, range.start), end: Math.min(s.end, range.end) }));

  return piecesFromCuts(range, mergeIntervals([...wordCuts, ...silenceCuts]), keepHalf);
}

/**
 * Splits a run at shot-boundary times that fall well inside it (more than `edgeGuard` from
 * either edge), so a piece never straddles a camera change. Pure.
 */
function splitAtShots(run: Piece, shots: Shot[], edgeGuard: number): Piece[] {
  const boundaries = shots
    .map((s) => s.start)
    .filter((t) => t - run.start > edgeGuard && run.end - t > edgeGuard)
    .sort((a, b) => a - b);
  const points = [run.start, ...boundaries, run.end];
  const pieces: Piece[] = [];
  for (let i = 0; i < points.length - 1; i++) pieces.push({ start: points[i], end: points[i + 1] });
  return pieces;
}

/**
 * Merges any piece shorter than `minSeg` into its previous piece (or the next one, if it's the
 * first piece of the run) by extending the neighbour and dropping the shot cut between them.
 * Restarts the scan after each merge so short pieces created by a merge cascade correctly. Pure.
 */
function mergeShortPieces(pieces: Piece[], minSeg: number): Piece[] {
  const result = pieces.map((p) => ({ ...p }));
  let changed = true;
  while (changed && result.length > 1) {
    changed = false;
    for (let i = 0; i < result.length; i++) {
      if (result[i].end - result[i].start < minSeg) {
        if (i > 0) {
          result[i - 1] = { start: result[i - 1].start, end: result[i].end };
        } else {
          result[i + 1] = { start: result[i].start, end: result[i + 1].end };
        }
        result.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return result;
}

const RETIME_WINDOW = 0.25; // seconds a fully-swallowed word gets re-timed into, at the start of the next kept piece

/**
 * Maps a range's words onto its own (already source-time-sorted, non-overlapping) kept pieces,
 * in output-timeline seconds. Root-cause fix (2026-09-26): a silence-based cut can now land in
 * the *middle* of a word's span (a whisper word can smear across real silence — see
 * debug-dead-air.md), so a word is no longer just "in piece X or dropped":
 *   - fully inside one piece (the common case, no cut nearby): mapped straight through, same as
 *     before.
 *   - straddling a cut (overlaps a piece only partially): clipped to its kept portion (the piece
 *     with the largest overlap) — never shown past the point the audio was actually cut.
 *   - entirely inside a removed interval (no overlap with any piece in this range): re-timed into
 *     the first `RETIME_WINDOW` seconds of the next piece (by source position) in this range, so
 *     it still appears once speech resumes instead of vanishing silently. Several such words
 *     collapsing on the same piece are spread evenly across that window, in their original
 *     (source-time) order.
 * Restricted to one playback range's own pieces (not the whole clip's) so a word can't be
 * re-timed across the cold-open/main-range boundary, which isn't a "cut" in this sense. Pure.
 */
function placeWords(words: Word[], range: Range, pieces: Piece[], pieceOuts: number[]): TimedWord[] {
  const timed: TimedWord[] = [];
  const orphansByPiece = new Map<number, Word[]>();

  const candidates = words.filter((w) => w.start >= range.start && w.start <= range.end);
  for (const w of candidates) {
    let bestIdx = -1;
    let bestOverlap = 0;
    for (let k = 0; k < pieces.length; k++) {
      const p = pieces[k];
      const overlap = Math.min(w.end, p.end) - Math.max(w.start, p.start);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestIdx = k;
      }
    }
    if (bestIdx === -1) {
      const nextIdx = pieces.findIndex((p) => p.start >= w.start);
      if (nextIdx === -1) continue; // no later piece in this range to re-time into — can't be shown
      if (!orphansByPiece.has(nextIdx)) orphansByPiece.set(nextIdx, []);
      orphansByPiece.get(nextIdx)!.push(w);
      continue;
    }
    const p = pieces[bestIdx];
    const clipStart = Math.max(w.start, p.start);
    const clipEnd = Math.min(w.end, p.end);
    timed.push({ ...w, outStart: pieceOuts[bestIdx] + (clipStart - p.start), outEnd: pieceOuts[bestIdx] + (clipEnd - p.start) });
  }

  for (const [pieceIdx, ws] of orphansByPiece) {
    const sorted = [...ws].sort((a, b) => a.start - b.start);
    const pieceOut = pieceOuts[pieceIdx];
    const window = Math.min(RETIME_WINDOW, pieces[pieceIdx].end - pieces[pieceIdx].start);
    const slice = window / sorted.length;
    sorted.forEach((w, idx) => {
      timed.push({ ...w, outStart: pieceOut + idx * slice, outEnd: pieceOut + (idx + 1) * slice });
    });
  }

  return timed;
}

function findShotIndex(shots: Shot[], piece: Piece): number {
  const mid = (piece.start + piece.end) / 2;
  let idx = shots.findIndex((s) => s.start <= mid && mid <= s.end);
  if (idx === -1) idx = shots.findIndex((s) => s.start <= piece.start && piece.start <= s.end);
  return idx;
}

/**
 * Builds the Edit Decision List: which source ranges to play (long pauses tightened, cuts split
 * at camera changes), how to crop each piece (delegated to `planLayout`, shared across pieces
 * in the same shot for stability), word-timed caption pages on the output timeline, and the hook
 * overlay. Pure — all times in `i` are source seconds; segments are translated into hi-res-file
 * seconds via `hiresOffset`, and captions/hook are in output-timeline seconds. See
 * task-11-brief.md for the exact algorithm this implements.
 */
export function buildEdl(i: EdlInput): Edl {
  const maxPause = i.opts?.maxPause ?? 0.45;
  const keepPause = i.opts?.keepPause ?? 0.15;
  const minSeg = i.opts?.minSeg ?? 0.5;
  const hookSec = i.opts?.hookSec ?? 3.2;
  const keepHalf = keepPause / 2;

  // Step 1: cold open (if any) plays first, then the main range.
  const ranges: Range[] = i.coldOpen ? [i.coldOpen, { start: i.start, end: i.end }] : [{ start: i.start, end: i.end }];

  // Steps 2-3: pause-tightened runs, split at shot boundaries, short pieces merged away.
  const silences = i.silences ?? [];
  const pieces: Piece[] = [];
  // [start,end) index spans into `pieces` per entry of `ranges` — used below (step 6) so caption
  // placement/re-timing only looks for "the next kept piece" within the same playback range, not
  // across the cold-open/main-range boundary (which isn't a pause cut).
  const rangePieceSpans: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const before = pieces.length;
    for (const run of speechRuns(range, i.words, maxPause, keepHalf, silences)) {
      pieces.push(...mergeShortPieces(splitAtShots(run, i.shots, EDGE_GUARD), minSeg));
    }
    rangePieceSpans.push({ start: before, end: pieces.length });
  }

  // Step 4-5: layout (shared per shot) + segments in hi-res-file seconds.
  const layoutByShot = new Map<number, Layout>();
  const segments: EdlSegment[] = pieces.map((piece) => {
    const shotIdx = findShotIndex(i.shots, piece);
    let layout = shotIdx >= 0 ? layoutByShot.get(shotIdx) : undefined;
    if (!layout) {
      const shot = shotIdx >= 0 ? i.shots[shotIdx] : undefined;
      let faceSamples = shot ? i.faces.filter((f) => f.t >= shot.start && f.t <= shot.end) : [];
      if (faceSamples.length === 0) {
        const mid = (piece.start + piece.end) / 2;
        faceSamples = [...i.faces].sort((a, b) => Math.abs(a.t - mid) - Math.abs(b.t - mid)).slice(0, 2);
      }
      layout = planLayout(faceSamples, i.srcAspect, i.override);
      if (shotIdx >= 0) layoutByShot.set(shotIdx, layout);
    }
    return { srcStart: round3(piece.start - i.hiresOffset), srcEnd: round3(piece.end - i.hiresOffset), layout };
  });

  // Step 6: output-timeline map + word-timed caption pages.
  const pieceOuts: number[] = [];
  let acc = 0;
  for (const piece of pieces) {
    pieceOuts.push(acc);
    acc += piece.end - piece.start;
  }
  const durationSec = acc;

  const timed: TimedWord[] = [];
  ranges.forEach((range, g) => {
    const { start, end } = rangePieceSpans[g];
    timed.push(...placeWords(i.words, range, pieces.slice(start, end), pieceOuts.slice(start, end)));
  });
  timed.sort((a, b) => a.outStart - b.outStart);

  const captions: EdlCaption[] = [];
  let page: TimedWord[] = [];
  const flushPage = () => {
    if (page.length === 0) return;
    captions.push({
      start: round3(page[0].outStart),
      end: round3(page[page.length - 1].outEnd + PAGE_END_PAD),
      words: page.map((w) => ({ w: w.w, start: round3(w.outStart), end: round3(w.outEnd) })),
    });
    page = [];
  };
  timed.forEach((w, idx) => {
    page.push(w);
    const next = timed[idx + 1];
    const endsWithPunct = END_PUNCT_RE.test(w.w);
    const bigGap = next ? next.start - w.end > PAGE_GAP_BREAK : false; // source-time gap, not output-time
    if (page.length >= PAGE_MAX_WORDS || endsWithPunct || bigGap || !next) flushPage();
  });

  // Page end = min(next page's start, last word end + pad), computed after all pages exist.
  for (let p = 0; p < captions.length; p++) {
    const nextStart = p + 1 < captions.length ? captions[p + 1].start : Infinity;
    captions[p] = { ...captions[p], end: Math.min(captions[p].end, nextStart) };
  }

  const hook = i.hook ? { text: i.hook, start: 0, end: round3(Math.min(hookSec, durationSec)) } : null;

  return {
    fps: 30,
    width: 1080,
    height: 1920,
    videoSrc: i.videoSrc,
    srcAspect: i.srcAspect,
    segments,
    captions,
    hook,
    durationSec: round3(durationSec),
    style: i.style,
  };
}

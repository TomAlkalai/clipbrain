import type { Edl, EdlCaption, EdlSegment, FaceSample, Layout, Shot, Word } from '../types.js';
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
  opts?: { maxPause?: number; keepPause?: number; minSeg?: number; hookSec?: number };
};

type Range = { start: number; end: number };
type Piece = { start: number; end: number };

const EDGE_GUARD = 0.3; // a shot cut must be this far from either edge of a run to be honoured
const PAGE_MAX_WORDS = 3;
const PAGE_END_PAD = 0.4; // extra tail shown after the last word of a caption page
const PAGE_GAP_BREAK = 0.3; // source-time gap that forces a caption page break
const END_PUNCT_RE = /[.?!,]$/;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

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
 * Splits a range's fully-contained words into speech runs, cutting wherever the gap between
 * consecutive words exceeds `maxPause` — this is the "tighten long pauses" step. `keepHalf`
 * (keepPause/2) of silence is kept on each side of a cut for breathing room. The very first run
 * starts at `range.start` and the very last run ends at `range.end`, not at the first/last
 * word's own timing, so a range boundary never clips inward. Pure.
 */
function speechRuns(range: Range, words: Word[], maxPause: number, keepHalf: number): Piece[] {
  const inRange = words.filter((w) => w.start >= range.start && w.end <= range.end).sort((a, b) => a.start - b.start);
  if (inRange.length === 0) return [];

  const cutAt: number[] = []; // indices i where the gap between inRange[i-1] and inRange[i] exceeds maxPause
  for (let i = 1; i < inRange.length; i++) {
    if (inRange[i].start - inRange[i - 1].end > maxPause) cutAt.push(i);
  }

  const runs: Piece[] = [];
  let runStartIdx = 0;
  for (let c = 0; c <= cutAt.length; c++) {
    const isFirst = c === 0;
    const isLast = c === cutAt.length;
    const endIdx = isLast ? inRange.length - 1 : cutAt[c] - 1;
    const start = isFirst ? range.start : inRange[runStartIdx].start - keepHalf;
    const end = isLast ? range.end : inRange[endIdx].end + keepHalf;
    runs.push({ start, end });
    if (!isLast) runStartIdx = cutAt[c];
  }
  return runs;
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
  const pieces: Piece[] = [];
  for (const range of ranges) {
    for (const run of speechRuns(range, i.words, maxPause, keepHalf)) {
      pieces.push(...mergeShortPieces(splitAtShots(run, i.shots, EDGE_GUARD), minSeg));
    }
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

  type TimedWord = Word & { outStart: number; outEnd: number };
  const timed: TimedWord[] = [];
  pieces.forEach((piece, k) => {
    const pieceOut = pieceOuts[k];
    const pieceDur = piece.end - piece.start;
    const isLastPiece = k === pieces.length - 1;
    const wordsIn = i.words.filter((w) => w.start >= piece.start && (isLastPiece ? w.start <= piece.end : w.start < piece.end));
    for (const w of wordsIn) {
      const outStart = clamp(pieceOut + (w.start - piece.start), pieceOut, pieceOut + pieceDur);
      const outEnd = clamp(pieceOut + (w.end - piece.start), pieceOut, pieceOut + pieceDur);
      timed.push({ ...w, outStart, outEnd });
    }
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

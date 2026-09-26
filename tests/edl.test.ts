import { it, expect } from 'vitest';
import { cropRect, planLayout } from '../src/edit/crop.js';
import { buildEdl } from '../src/edit/edl.js';
const A = 16 / 9;
it('cropRect clamps to frame', () => {
  const r = cropRect({ cx: 0.02, cy: 0.5, zoom: 1 }, 9 / 16, A);
  expect(r.x).toBe(0); expect(r.h).toBe(1); expect(r.w).toBeCloseTo(0.3164, 3);
});
it('single face → face layout centred on the face', () => {
  const s = [0, 1, 2].map(t => ({ t, faces: [{ x: 0.6, y: 0.2, w: 0.1, h: 0.25, score: 0.95 }] }));
  expect(planLayout(s, A)).toMatchObject({ kind: 'face', cx: 0.65, zoom: 1 });
});
it('two separated faces → split', () => {
  const s = [0, 1, 2].map(t => ({ t, faces: [{ x: 0.1, y: 0.2, w: 0.1, h: 0.2, score: 0.9 }, { x: 0.75, y: 0.25, w: 0.1, h: 0.2, score: 0.9 }] }));
  const l = planLayout(s, A) as any;
  expect(l.kind).toBe('split'); expect(l.top.cx).toBeCloseTo(0.15); expect(l.bottom.cx).toBeCloseTo(0.8);
});
it('no faces → fit', () => { expect(planLayout([{ t: 0, faces: [] }], A)).toEqual({ kind: 'fit' }); });
const words = [
  { w: 'Hello', start: 10.0, end: 10.4 }, { w: 'world.', start: 10.4, end: 10.9 },
  { w: 'After', start: 12.0, end: 12.3 }, { w: 'pause', start: 12.3, end: 12.8 }, { w: 'end.', start: 12.8, end: 13.2 },
  { w: 'Payoff', start: 20.0, end: 20.5 }, { w: 'line.', start: 20.5, end: 21.0 }];
const base = { words, shots: [{ start: 0, end: 12.5 }, { start: 12.5, end: 60 }], faces: [{ t: 11, faces: [] }, { t: 13, faces: [] }],
  srcAspect: A, hiresOffset: 9, videoSrc: 'x.mp4', hook: 'Big hook', style: 'default' };
it('tightens long pauses and splits at shot cuts', () => {
  const e = buildEdl({ ...base, start: 9.9, end: 13.4, coldOpen: null });
  expect(e.segments.length).toBe(3);
  expect(e.segments[0].srcStart).toBeCloseTo(0.9);
  expect(e.segments[0].srcEnd).toBeCloseTo(10.975 - 9);
  expect(e.segments[1].srcStart).toBeCloseTo(11.925 - 9);
  expect(e.durationSec).toBeCloseTo((10.975 - 9.9) + (12.5 - 11.925) + (13.4 - 12.5), 3);
  expect(e.hook).toEqual({ text: 'Big hook', start: 0, end: 2.55 });
});
it('cold open comes first and captions are monotonic in output time', () => {
  const e = buildEdl({ ...base, start: 9.9, end: 13.4, coldOpen: { start: 19.9, end: 21.2 } });
  expect(e.segments[0].srcStart).toBeCloseTo(10.9);
  const starts = e.captions.map(c => c.start);
  expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  expect(e.captions[0].words.map(w => w.w)).toEqual(['Payoff', 'line.']);
  expect(e.captions[0].start).toBeCloseTo(0.1);
});

// ---- silence-aware pause tightening (dead-air root-cause fix, 2026-09-26) ----
// Mirrors the real evidence in debug-dead-air.md: whisper word timings smear across a real
// audio silence with ~0 gap between consecutive words, so the existing word-gap cutter never
// sees it. silences.json (ffmpeg silencedetect) independently reports the real silence.
const silenceWords = [
  { w: 'as', start: 5.00, end: 5.10 },
  { w: 'a', start: 5.10, end: 5.20 },
  { w: 'business', start: 5.20, end: 6.80 },
  { w: 'grows,', start: 6.95, end: 7.30 },
];
const silenceBase = {
  words: silenceWords,
  shots: [{ start: 0, end: 10 }],
  faces: [{ t: 5, faces: [] }],
  srcAspect: A, hiresOffset: 0, videoSrc: 'x.mp4', hook: null, style: 'default',
  start: 0, end: 10, coldOpen: null,
};

it('cuts a real silence that whisper words smear across (no word gap), dropping duration by ~(silence - keepPause)', () => {
  const e = buildEdl({ ...silenceBase, silences: [{ start: 5.05, end: 6.95 }] });
  // silence duration 1.9s, default keepPause 0.15s -> drop ~1.75s (10 - 1.75 = 8.25)
  expect(e.durationSec).toBeCloseTo(10 - (1.9 - 0.15), 3);
  expect(e.segments.length).toBe(2);
  expect(e.segments[0].srcEnd).toBeCloseTo(5.125, 3);
  expect(e.segments[1].srcStart).toBeCloseTo(6.875, 3);
});

it('never shows a caption word at an output time before its piece begins, and clips/re-times words the silence swallowed', () => {
  const e = buildEdl({ ...silenceBase, silences: [{ start: 5.05, end: 6.95 }] });
  const allWords = e.captions.flatMap((c) => c.words);
  const find = (w: string) => {
    const found = allWords.find((x) => x.w === w);
    if (!found) throw new Error(`word "${w}" missing from captions entirely`);
    return found;
  };
  // 'a' straddles the cut start: clipped to its kept portion (piece 0 ends at output 5.125s),
  // not shown through to its natural (pre-cut) end of 5.20.
  const a = find('a');
  expect(a.start).toBeCloseTo(5.10, 3);
  expect(a.end).toBeCloseTo(5.125, 3);
  // 'business' lies entirely inside the removed interval: re-timed into the first 0.25s of the
  // next kept piece (which begins at output 5.125s) instead of vanishing or bleeding earlier
  // (into piece 0's own output slot, which would mean showing it "inside the cut").
  const business = find('business');
  expect(business.start).toBeGreaterThanOrEqual(5.125 - 1e-6);
  expect(business.end - business.start).toBeLessThanOrEqual(0.25 + 1e-6);
  // 'grows,' resumes normally once real speech is back.
  const grows = find('grows,');
  expect(grows.start).toBeCloseTo(5.2, 3);
  expect(grows.end).toBeCloseTo(5.55, 3);
  // caption pages stay monotonic (existing invariant, still holds with the new cut source)
  const starts = e.captions.map((c) => c.start);
  expect([...starts].sort((x, y) => x - y)).toEqual(starts);
});

it('with no silences given, behaves exactly as before (word-gap-only tightening is unaffected)', () => {
  const withEmptySilences = buildEdl({ ...base, start: 9.9, end: 13.4, coldOpen: null, silences: [] });
  const withoutSilencesField = buildEdl({ ...base, start: 9.9, end: 13.4, coldOpen: null });
  expect(withEmptySilences.durationSec).toBeCloseTo(withoutSilencesField.durationSec, 6);
  expect(withEmptySilences.segments).toEqual(withoutSilencesField.segments);
});

// ---- Fix round 1 (coordinator review, 2026-09-26) ----

// item 1: a re-timed orphan word's window must never run past the next REAL word in the same
// piece — previously it used a fixed 0.25s window regardless of where the next real word started.
it('bounds a re-timed orphan word to end at-or-before the next real word in the same piece, even when they land on the same caption page', () => {
  const words = [
    { w: 'hello', start: 0.0, end: 0.5 },
    { w: 'swallowed', start: 2.10, end: 2.50 }, // entirely inside the cut -> orphan, re-timed
    { w: 'resumed', start: 2.55, end: 3.00 }, // real word, right after the orphan in the same piece
  ];
  const e = buildEdl({
    words,
    shots: [{ start: 0, end: 10 }],
    faces: [{ t: 1, faces: [] }],
    srcAspect: A, hiresOffset: 0, videoSrc: 'x.mp4', hook: null, style: 'default',
    start: 0, end: 10, coldOpen: null,
    silences: [{ start: 2.0, end: 2.6 }],
  });

  const allWords = e.captions.flatMap((c) => c.words);
  const find = (w: string) => allWords.find((x) => x.w === w)!;
  const swallowed = find('swallowed');
  const resumed = find('resumed');

  // every word has positive duration, and the orphan never overlaps the real word after it
  expect(swallowed.end).toBeGreaterThan(swallowed.start);
  expect(resumed.end).toBeGreaterThan(resumed.start);
  expect(swallowed.end).toBeLessThanOrEqual(resumed.start);
  expect(swallowed.start).toBeCloseTo(0.575, 3);
  expect(swallowed.end).toBeCloseTo(0.6, 3);
  expect(resumed.start).toBeCloseTo(0.6, 3);
  expect(resumed.end).toBeCloseTo(1.05, 3);

  // they really do land on the same caption page
  const page = e.captions.find((c) => c.words.some((w) => w.w === 'swallowed'));
  expect(page?.words.map((w) => w.w)).toEqual(['swallowed', 'resumed']);

  // global invariant: no two words in the whole EDL overlap in output time
  const sorted = [...allWords].sort((a, b) => a.start - b.start);
  for (let k = 1; k < sorted.length; k++) {
    expect(sorted[k].start).toBeGreaterThanOrEqual(sorted[k - 1].end);
  }
});

// item 3: a cut right at a range boundary (or two cuts close together) can leave a sub-minSeg
// piece with no sibling of its own run to merge into — it must still be cleaned up, and cleaning
// it up must never bridge a real (kept) pause gap back together (which would silently reintroduce
// dead air — the opposite of this whole fix).
const minimalBase = {
  shots: [{ start: 0, end: 30 }],
  faces: [{ t: 1, faces: [] }],
  srcAspect: A, hiresOffset: 0, videoSrc: 'x.mp4', hook: null, style: 'default',
};

it('drops a sub-0.15s sliver left by a silence starting exactly at range.start', () => {
  const e = buildEdl({
    ...minimalBase,
    words: [{ w: 'ok', start: 1.95, end: 2.3 }, { w: 'next', start: 2.31, end: 2.6 }],
    start: 0, end: 10, coldOpen: null,
    silences: [{ start: 0, end: 2.0 }],
  });
  expect(e.segments.length).toBe(1);
  expect(e.segments[0].srcStart).toBeCloseTo(1.925, 3);
  expect(e.segments[0].srcEnd).toBeCloseTo(10, 3);
  expect(e.durationSec).toBeCloseTo(8.075, 3); // NOT 8.15 — the 0.075s sliver was dropped, not kept
});

it('drops a sub-0.15s sliver left by a silence ending exactly at range.end', () => {
  const e = buildEdl({
    ...minimalBase,
    words: [{ w: 'start', start: 0.5, end: 1.0 }, { w: 'more', start: 1.01, end: 1.3 }],
    start: 0, end: 10, coldOpen: null,
    silences: [{ start: 8.0, end: 10.0 }],
  });
  expect(e.segments.length).toBe(1);
  expect(e.segments[0].srcStart).toBeCloseTo(0, 3);
  expect(e.segments[0].srcEnd).toBeCloseTo(8.075, 3);
  expect(e.durationSec).toBeCloseTo(8.075, 3);
});

it('drops the same kind of sliver in the cold-open range (scoped per-range, main range unaffected)', () => {
  const e = buildEdl({
    ...minimalBase,
    words: [
      { w: 'flash', start: 21.95, end: 22.3 },
      { w: 'main1', start: 0.5, end: 1.0 },
      { w: 'main2', start: 1.01, end: 1.3 },
    ],
    start: 0, end: 5, coldOpen: { start: 20, end: 23 },
    silences: [{ start: 20, end: 22 }],
  });
  // cold open plays first: its own tiny sliver at [20, 20.075] is dropped, leaving just [21.925,23]
  expect(e.segments.length).toBe(2);
  expect(e.segments[0].srcStart).toBeCloseTo(21.925, 3);
  expect(e.segments[0].srcEnd).toBeCloseTo(23, 3);
  expect(e.segments[1].srcStart).toBeCloseTo(0, 3);
  expect(e.segments[1].srcEnd).toBeCloseTo(5, 3);
  expect(e.durationSec).toBeCloseTo(1.075 + 5, 3);
});

it('an isolated short run boxed in by two real pause cuts is dropped, never bridged back into a neighbour (would reintroduce dead air)', () => {
  // Two word-gap cuts leave a 0.45s middle run (below the 0.5s default minSeg) with a real,
  // deliberately-kept pause gap on BOTH sides — merging it into either neighbour would extend a
  // segment's srcStart/srcEnd across one of those gaps, silently re-including the cut dead air.
  const e = buildEdl({
    ...minimalBase,
    words: [
      { w: 'w1', start: 0.0, end: 2.0 },
      { w: 'w2', start: 3.0, end: 3.3 }, // the short, isolated middle run
      { w: 'w3', start: 4.3, end: 19.9 },
    ],
    start: 0, end: 20, coldOpen: null,
    silences: [],
  });
  expect(e.segments.length).toBe(2);
  expect(e.segments[0].srcStart).toBeCloseTo(0, 3);
  expect(e.segments[0].srcEnd).toBeCloseTo(2.075, 3);
  expect(e.segments[1].srcStart).toBeCloseTo(4.225, 3);
  expect(e.segments[1].srcEnd).toBeCloseTo(20, 3);
  // neither segment spans across either of the two real gaps ([2.075,2.925] or [3.375,4.225])
  expect(e.durationSec).toBeCloseTo(2.075 + 15.775, 3);
});

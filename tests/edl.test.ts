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

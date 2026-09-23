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

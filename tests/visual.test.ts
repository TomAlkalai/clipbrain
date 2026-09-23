import { it, expect } from 'vitest';
import { detectShots, frameDiff } from '../src/analyze/shots.js';
import { nms, letterbox } from '../src/analyze/faces.js';
import { readFrames } from '../src/analyze/frames.js';

it('detects hard cuts and ignores noise', () => {
  const diffs = Array.from({ length: 100 }, (_, i) => ({ t: (i + 1) * 0.2, d: i === 39 || i === 79 ? 60 : 3 + (i % 3) }));
  const shots = detectShots(diffs, 20.2);
  expect(shots.map(s => +s.start.toFixed(1))).toEqual([0, 8, 16]);
  expect(shots[shots.length - 1].end).toBeCloseTo(20.2);
});
it('frameDiff', () => { expect(frameDiff(new Uint8Array([0, 10]), new Uint8Array([10, 10]))).toBe(5); });
it('nms keeps the best of overlapping boxes', () => {
  const r = nms([{ x: 0, y: 0, w: 0.2, h: 0.2, score: 0.9 }, { x: 0.01, y: 0.01, w: 0.2, h: 0.2, score: 0.8 }, { x: 0.6, y: 0.6, w: 0.1, h: 0.1, score: 0.75 }], 0.3);
  expect(r.map(b => b.score)).toEqual([0.9, 0.75]);
});
it('letterboxes a 320x180 frame into 320x240', () => {
  const lb = letterbox(Buffer.alloc(320 * 180 * 3, 255), 320, 180);
  expect(lb.data.length).toBe(3 * 240 * 320); expect(lb.padTop).toBe(30); expect(lb.contentH).toBe(180);
  expect(lb.data[0]).toBeCloseTo(-127 / 128); expect(lb.data[320 * 100]).toBeCloseTo(1);
});
it('letterbox throws instead of silently cropping a too-tall (portrait) frame', () => {
  expect(() => letterbox(Buffer.alloc(320 * 260 * 3), 320, 260)).toThrow(/exceeds/);
});
it('readFrames rejects for a nonexistent file instead of yielding 0 frames silently', async () => {
  const gen = readFrames('this-file-does-not-exist-12345.mp4', { fps: 5, width: 320, height: 180 });
  await expect(gen.next()).rejects.toThrow();
});

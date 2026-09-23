import { it, expect } from 'vitest';
import { buildIndex, alignShort } from '../src/mine/align.js';
const mk = (text: string, t0 = 0, dt = 0.5) => text.split(' ').map((w, i) => ({ w, start: t0 + i * dt, end: t0 + (i + 1) * dt }));
const epText = Array.from({ length: 400 }, (_, i) => `w${i}`).join(' ');
const idx = buildIndex([{ id: 'ep1', words: mk(epText), durationSec: 200 }, { id: 'ep2', words: mk(Array.from({ length: 300 }, (_, i) => `z${i}`).join(' ')), durationSec: 150 }]);
it('aligns a contiguous excerpt', () => {
  const short = mk(Array.from({ length: 40 }, (_, i) => `w${100 + i}`).join(' '));
  const a = alignShort('s1', short, idx)!;
  expect(a.episodeId).toBe('ep1');
  expect(a.segments).toHaveLength(1);
  expect(a.segments[0].srcStart).toBeCloseTo(50); expect(a.segments[0].srcEnd).toBeCloseTo(70);
  expect(a.coverage).toBeGreaterThan(0.95);
});
it('detects a cold open (later excerpt first)', () => {
  const words = [...Array.from({ length: 15 }, (_, i) => `w${300 + i}`), ...Array.from({ length: 40 }, (_, i) => `w${100 + i}`)];
  const a = alignShort('s2', mk(words.join(' ')), idx)!;
  expect(a.segments.length).toBe(2);
  expect(a.segments[0].srcStart).toBeGreaterThan(a.segments[1].srcStart);
});
it('returns null for unrelated text', () => {
  expect(alignShort('s3', mk(Array.from({ length: 40 }, (_, i) => `q${i}`).join(' ')), idx)).toBeNull();
});

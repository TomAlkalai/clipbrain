import { it, expect } from 'vitest';
import { median, perfScores, shortFeatures } from '../src/mine/features.js';
it('median', () => { expect(median([3, 1, 2])).toBe(2); expect(median([1, 2, 3, 4])).toBe(2.5); });
it('perf is log ratio to channel median, excluding young shorts', () => {
  const s = (id: string, views: number, uploadDate: string) => ({ id, title: id, views, uploadDate, durationSec: 30, channelUrl: 'c' });
  const m = perfScores([s('a', 100, '20260101'), s('b', 1000, '20260101'), s('c', 10000, '20260101'), s('d', 5, '20260922')], new Date('2026-09-23'));
  expect(m.get('b')).toBeCloseTo(0); expect(m.get('c')).toBeCloseTo(Math.log(10)); expect(m.has('d')).toBe(false);
});
it('features: cold open + position', () => {
  const words = Array.from({ length: 400 }, (_, i) => ({ w: `w${i}`, start: i * 0.5, end: i * 0.5 + 0.4 }));
  const f = shortFeatures({ id: 's', title: 'T', views: 10, uploadDate: '', durationSec: 28, channelUrl: 'c' },
    { shortId: 's', episodeId: 'e', coverage: 1, hits: 40, segments: [
      { shortStart: 0, shortEnd: 6, srcStart: 150, srcEnd: 156, tokens: 12 },
      { shortStart: 6, shortEnd: 28, srcStart: 50, srcEnd: 72, tokens: 44 }] },
    { words, durationSec: 200 }, 0.5, words.slice(0, 10));
  expect(f.coldOpen).toBe(true); expect(f.nSegments).toBe(2); expect(f.positionInEpisode).toBeCloseTo(0.25);
  expect(f.srcSpanSec).toBeCloseTo(28);
});

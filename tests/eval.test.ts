import { it, expect } from 'vitest';
import { officialSpan, overlapRatio } from '../src/eval.js';
import type { Alignment } from '../src/types.js';

it('officialSpan is the min srcStart .. max srcEnd across all segments', () => {
  const a: Alignment = {
    shortId: 's1',
    episodeId: 'e1',
    segments: [
      { shortStart: 0, shortEnd: 2, srcStart: 100, srcEnd: 102, tokens: 5 },
      { shortStart: 2, shortEnd: 5, srcStart: 110, srcEnd: 114, tokens: 8 },
      { shortStart: 5, shortEnd: 8, srcStart: 105, srcEnd: 108, tokens: 6 },
    ],
    coverage: 0.9,
    hits: 19,
  };
  expect(officialSpan(a)).toEqual({ srcStart: 100, srcEnd: 114 });
});

it('overlapRatio is 1 when the candidate fully covers the official span', () => {
  expect(overlapRatio(90, 120, 100, 110)).toBe(1);
});

it('overlapRatio is 0 for disjoint windows', () => {
  expect(overlapRatio(0, 10, 100, 110)).toBe(0);
});

it('overlapRatio is the fraction of the official span covered by a partial overlap', () => {
  // official span is 100..110 (10s); candidate covers 105..110 (5s of it) => 0.5
  expect(overlapRatio(105, 200, 100, 110)).toBeCloseTo(0.5);
});

it('overlapRatio is 0 when the official span has zero or negative length', () => {
  expect(overlapRatio(0, 100, 50, 50)).toBe(0);
});

import { it, expect } from 'vitest';
import { spearman, updateWeights, buckets } from '../src/learn/learn.js';
import { SIGNALS } from '../src/types.js';
import type { Clip, Scores, SignalName } from '../src/types.js';

function scoresWith(overrides: Partial<Record<SignalName, number>>): Scores {
  return Object.fromEntries(SIGNALS.map((s) => [s, { score: overrides[s] ?? 5, reason: '' }])) as Scores;
}

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c',
    sourceId: 'src',
    creator: 'doac',
    candidateId: 'cand',
    start: 0,
    end: 40,
    coldOpen: null,
    title: 't',
    description: '',
    hashtags: [],
    hooks: [{ text: 't', pattern: 'question', score: 0 }],
    hookIndex: 0,
    scores: scoresWith({}),
    composite: 7,
    rankReason: '',
    patterns: [],
    hiresOffset: 0,
    status: 'published',
    renders: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Clip;
}

it('spearman is 1 for a perfectly increasing relationship', () => {
  expect(spearman([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
});

it('spearman is -1 for a perfectly decreasing relationship', () => {
  expect(spearman([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1);
});

it('updateWeights returns the prior unchanged when n < 8', () => {
  const prior = Object.fromEntries(SIGNALS.map((s) => [s, 1])) as Record<SignalName, number>;
  const samples = Array.from({ length: 5 }, (_, i) => ({ scores: scoresWith({ hook: i }), y: i }));
  const result = updateWeights(prior, samples);
  expect(result.weights).toEqual(prior);
  expect(result.correlations).toEqual({});
});

it('updateWeights pushes a perfectly predictive signal toward 2 and leaves uncorrelated ones near 1 (n=20)', () => {
  const prior = Object.fromEntries(SIGNALS.map((s) => [s, 1])) as Record<SignalName, number>;
  const samples = Array.from({ length: 20 }, (_, i) => ({
    scores: scoresWith({ hook: i }), // hook score strictly increases with y — perfect rank correlation
    y: i,
  }));
  const result = updateWeights(prior, samples);
  expect(result.weights.hook).toBeCloseTo(2, 1);
  expect(result.correlations.hook?.rho).toBeCloseTo(1, 5);
  for (const s of SIGNALS) {
    if (s === 'hook') continue;
    expect(result.weights[s]).toBeCloseTo(1, 1);
  }
});

it('buckets only reports groups with n >= 3', () => {
  const rows = [
    { clip: clip({ coldOpen: { start: 0, end: 1 } }), y: 1 },
    { clip: clip({ coldOpen: { start: 0, end: 1 } }), y: 0.6 },
    { clip: clip({ coldOpen: { start: 0, end: 1 } }), y: 0.8 },
    { clip: clip({ coldOpen: null }), y: -0.5 },
    { clip: clip({ coldOpen: null }), y: -0.4 },
  ];
  const b = buckets(rows);
  const coldOpenYes = b.find((x) => x.feature === 'coldOpen' && x.value === 'yes');
  const coldOpenNo = b.find((x) => x.feature === 'coldOpen' && x.value === 'no');
  expect(coldOpenYes).toBeDefined();
  expect(coldOpenYes?.n).toBe(3);
  expect(coldOpenYes?.meanPerf).toBeCloseTo(0.8, 5);
  expect(coldOpenNo).toBeUndefined(); // n=2 < 3, filtered out
});

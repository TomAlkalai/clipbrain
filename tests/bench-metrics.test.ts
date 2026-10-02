import { it, expect } from 'vitest';
import {
  coverage, gradeOf, episodeMetrics, randomBaseline, bootstrapMean, pairedBootstrap, mulberry32, type OfficialMoment,
} from '../src/bench/metrics.js';

const moment = (shortId: string, perf: number | null, segments: { start: number; end: number }[]): OfficialMoment => ({
  shortId, title: shortId, perf, grade: gradeOf(perf), segments,
});
// o1 grade 3 (gain 7), o2 grade 2 (gain 3), o3 grade 1 (gain 1, never reached by the pool)
const moments = [
  moment('o1', 1.0, [{ start: 100, end: 140 }]),
  moment('o2', 0.2, [{ start: 300, end: 340 }]),
  moment('o3', -0.5, [{ start: 900, end: 930 }]),
];
const ranked = [
  { start: 500, end: 560 }, // miss
  { start: 95, end: 150 },  // o1
  { start: 290, end: 345 }, // o2
  { start: 100, end: 160 }, // o1 again: a near-duplicate earns nothing
  { start: 0, end: 50 },    // miss
];

it('coverage is measured per aligned segment, so cold-open Shorts are not stretched', () => {
  expect(coverage({ start: 100, end: 160 }, [{ start: 90, end: 130 }])).toBeCloseTo(30 / 40);
  expect(coverage({ start: 100, end: 140 }, [{ start: 2000, end: 2005 }, { start: 100, end: 140 }])).toBeCloseTo(40 / 45);
  expect(coverage({ start: 0, end: 10 }, [{ start: 50, end: 50 }])).toBe(0);
});

it('gradeOf: ≥2× median → 3, ≥ median → 2, below or unknown → 1', () => {
  expect([gradeOf(Math.log(2)), gradeOf(1.5), gradeOf(0.5), gradeOf(0), gradeOf(-0.1), gradeOf(null)]).toEqual([3, 3, 2, 2, 1, 1]);
});

it('episodeMetrics matches the hand-computed example (graded)', () => {
  const m = episodeMetrics(ranked, moments);
  const dcg = 7 / Math.log2(3) + 3 / Math.log2(4);
  expect(m.ndcgPool).toBeCloseTo(dcg / (7 + 3 / Math.log2(3)), 6);
  expect(m.ndcgAll).toBeCloseTo(dcg / (7 + 3 / Math.log2(3) + 1 / Math.log2(4)), 6);
  expect(m.precision).toBeCloseTo(3 / 5);
  expect(m.recall).toBeCloseTo(2 / 3);
  expect(m.mrr).toBeCloseTo(1 / 2);
  expect(m.poolRecall).toBeCloseTo(2 / 3);
  expect(m).toMatchObject({ nOfficial: 3, nMatchedInPool: 2 });
});

it('episodeMetrics: binary relevance gives every moment gain 1', () => {
  const m = episodeMetrics(ranked, moments, { graded: false });
  expect(m.ndcgPool).toBeCloseTo((1 / Math.log2(3) + 1 / Math.log2(4)) / (1 + 1 / Math.log2(3)), 6);
});

it('episodeMetrics: k cuts the list, and the threshold is configurable', () => {
  expect(episodeMetrics(ranked, moments, { k: 2 }).recall).toBeCloseTo(1 / 3);
  expect(episodeMetrics([{ start: 125, end: 200 }], moments, { threshold: 0.5 }).poolRecall).toBe(0); // covers 15/40 of o1
});

it('episodeMetrics: nDCG|pool is null when the pool reaches no official moment (nothing to rank)', () => {
  const m = episodeMetrics([{ start: 0, end: 10 }], moments);
  expect(m.ndcgPool).toBeNull();
  expect(m.ndcgAll).toBe(0);
  expect(m.mrr).toBe(0);
});

it('episodeMetrics: a candidate covering two official moments credits only one per position', () => {
  const two = [moment('a', 1, [{ start: 0, end: 30 }]), moment('b', 1, [{ start: 40, end: 70 }])];
  const m = episodeMetrics([{ start: 0, end: 70 }, { start: 35, end: 75 }], two);
  expect(m.ndcgPool).toBeCloseTo(1); // position 1 credits a, position 2 credits b
  expect(m.recall).toBe(1);
});

it('randomBaseline: expected precision@1 is the share of relevant candidates in the pool', () => {
  const pool = [{ start: 95, end: 150 }, { start: 500, end: 560 }, { start: 600, end: 660 }, { start: 700, end: 760 }];
  const r = randomBaseline(pool, moments, { k: 1 }, 4000, 7);
  expect(r.precision).toBeCloseTo(0.25, 1);
  expect(randomBaseline(pool, moments, { k: 1 }, 4000, 7)).toEqual(r); // seeded
});

it('bootstrapMean: deterministic, and the CI brackets the mean', () => {
  const xs = [0.1, 0.4, 0.35, 0.8, 0.2, 0.55, 0.6, 0.3];
  const a = bootstrapMean(xs, 2000, 42);
  expect(a).toEqual(bootstrapMean(xs, 2000, 42));
  expect(a.mean).toBeCloseTo(xs.reduce((s, x) => s + x, 0) / xs.length);
  expect(a.lo).toBeLessThanOrEqual(a.mean); expect(a.hi).toBeGreaterThanOrEqual(a.mean);
  expect(bootstrapMean([0.5, 0.5, 0.5], 500, 1)).toEqual({ mean: 0.5, lo: 0.5, hi: 0.5, n: 3 });
});

it('pairedBootstrap: bootstraps per-episode differences; skips episodes missing either value', () => {
  const d = pairedBootstrap([0.5, 0.6, null, 0.9], [0.4, 0.4, 0.3, 0.7], 1000, 3);
  expect(d.n).toBe(3);
  expect(d.mean).toBeCloseTo((0.1 + 0.2 + 0.2) / 3);
  expect(() => pairedBootstrap([1], [1, 2])).toThrow(/same episodes/);
});

it('mulberry32 is a deterministic [0,1) generator', () => {
  const r = mulberry32(9); const xs = [r(), r(), r()];
  const r2 = mulberry32(9); expect([r2(), r2(), r2()]).toEqual(xs);
  expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
});

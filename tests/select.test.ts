import { it, expect } from 'vitest';
import { windows, snapBounds, composite, dedupe, mergeFragmentedSentences } from '../src/select/snap.js';
import { topAudienceExamples } from '../src/select/rank.js';
const sent = (id: number, start: number, end: number) => ({ id, text: 's' + id, start, end, w0: id * 2, w1: id * 2 + 1 });
const S = Array.from({ length: 100 }, (_, i) => sent(i, i * 30, i * 30 + 28));
const W = S.flatMap(s => [{ w: 'a', start: s.start, end: s.start + 10 }, { w: 'b.', start: s.start + 10, end: s.end }]);
it('windows cover everything with overlap', () => {
  const w = windows(S, 1200, 90);
  expect(w[0].s0).toBe(0); expect(w[w.length - 1].s1).toBe(99);
  for (let i = 1; i < w.length; i++) expect(w[i].s0).toBeLessThanOrEqual(w[i - 1].s1);
});
// Sentences here are spaced 30s apart. Default windowSec=600 means a window holds sentences
// with start < winStart + 600, i.e. indices 0..19 (index 19 starts at 570s, index 20 at 600s is
// excluded); default overlapSec=60 steps the next window's start forward by 540s, landing s0 at
// the first sentence whose start >= 540s, i.e. index 18. This pins down the 600/60 defaults
// (as opposed to the old 1200/90 ones) without hardcoding windows()'s internals.
it('defaults to 600s windows with 60s overlap when called with no explicit window/overlap', () => {
  const w = windows(S);
  expect(w[0].s0).toBe(0);
  expect(w[0].s1).toBe(19);
  expect(w[1].s0).toBe(18);
  expect(w[w.length - 1].s1).toBe(99);
  for (let i = 1; i < w.length; i++) expect(w[i].s0).toBeLessThanOrEqual(w[i - 1].s1);
});
// Last-line-of-defense guards: a bad windowSec/overlapSec must fail loudly here rather than
// silently produce a degenerate window count (e.g. one window per sentence with NaN inputs),
// which would mean unbounded LLM calls in proposeWindow. The CLI validates its own flags before
// ever calling windows(), but any other caller relies on this throw.
it('windows throws when windowSec <= overlapSec', () => {
  expect(() => windows(S, 60, 60)).toThrow();
  expect(() => windows(S, 60, 90)).toThrow();
});
it('windows throws on non-finite windowSec or overlapSec', () => {
  expect(() => windows(S, NaN, 60)).toThrow();
  expect(() => windows(S, 600, NaN)).toThrow();
  expect(() => windows(S, Infinity, 60)).toThrow();
});
it('snaps to sentence bounds with padding but not into neighbours', () => {
  const b = snapBounds(S, W, 3, 4);
  expect(b.start).toBeCloseTo(89.88); expect(b.end).toBeCloseTo(148.3);
});
it('composite respects weights', () => {
  const sc: any = Object.fromEntries(['hook','standalone_clarity','payoff','novelty','emotional_intensity','information_density','audience_fit'].map((k, i) => [k, { score: i === 0 ? 10 : 5, reason: '' }]));
  const w: any = { hook: 3, standalone_clarity: 1, payoff: 1, novelty: 1, emotional_intensity: 1, information_density: 1, audience_fit: 1 };
  expect(composite(sc, w)).toBeCloseTo((30 + 30) / 9, 2);
});
it('dedupe keeps the higher composite of overlapping clips', () => {
  const c = (id: string, start: number, end: number, composite: number) => ({ id, start, end, composite }) as any;
  expect(dedupe([c('a', 0, 40, 6), c('b', 5, 45, 7), c('c', 100, 140, 5)]).map((x: any) => x.id)).toEqual(['b', 'c']);
});

// Found via the live run: buildSentences force-splits a run-on utterance mid-sentence when it
// hits its word cap (or a silence gap), leaving a punctuation-less fragment. An endSid landing
// on the fragment's head reads as a payoff cut off before it lands; a startSid landing on the
// fragment's tail reads as starting mid-thought. mergeFragmentedSentences absorbs those
// fragments so neither happens.
it('mergeFragmentedSentences absorbs an unpunctuated tail so the payoff is not cut off', () => {
  const s = [{ text: 'A.' }, { text: 'B is unfinished' }, { text: 'and now it lands.' }, { text: 'Next.' }] as any;
  expect(mergeFragmentedSentences(s, 0, 1)).toEqual({ startSid: 0, endSid: 2 });
});
it('mergeFragmentedSentences absorbs an unpunctuated head so the opening is not a fragment', () => {
  const s = [{ text: 'Intro.' }, { text: 'mid fragment' }, { text: 'tail.' }, { text: 'Next.' }] as any;
  expect(mergeFragmentedSentences(s, 2, 2)).toEqual({ startSid: 1, endSid: 2 });
});
it('mergeFragmentedSentences stops at a cap instead of absorbing forever', () => {
  const s = Array.from({ length: 10 }, () => ({ text: 'no punctuation here' })) as any;
  expect(mergeFragmentedSentences(s, 0, 0).endSid).toBe(3);
});

// topAudienceExamples feeds the final-rank prompt with the creator's own top-performing
// official Shorts, so the ranker can weigh audience fit against real examples.
it('topAudienceExamples returns the top n by perf, best first', () => {
  const f = (title: string, perf: number) => ({ title, perf }) as any;
  const features = [f('low', 0.1), f('best', 2.5), f('mid', 1.0), f('second', 2.0)];
  expect(topAudienceExamples(features, 2)).toEqual([
    { title: 'best', perf: 2.5 },
    { title: 'second', perf: 2.0 },
  ]);
});
it('topAudienceExamples returns fewer than n when there are not enough features', () => {
  const f = (title: string, perf: number) => ({ title, perf }) as any;
  expect(topAudienceExamples([f('only', 1)], 10)).toEqual([{ title: 'only', perf: 1 }]);
});
it('topAudienceExamples returns an empty array for no features', () => {
  expect(topAudienceExamples([], 10)).toEqual([]);
});

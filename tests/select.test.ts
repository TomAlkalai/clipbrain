import { it, expect } from 'vitest';
import { windows, snapBounds, composite, dedupe, mergeFragmentedSentences } from '../src/select/snap.js';
const sent = (id: number, start: number, end: number) => ({ id, text: 's' + id, start, end, w0: id * 2, w1: id * 2 + 1 });
const S = Array.from({ length: 100 }, (_, i) => sent(i, i * 30, i * 30 + 28));
const W = S.flatMap(s => [{ w: 'a', start: s.start, end: s.start + 10 }, { w: 'b.', start: s.start + 10, end: s.end }]);
it('windows cover everything with overlap', () => {
  const w = windows(S, 1200, 90);
  expect(w[0].s0).toBe(0); expect(w[w.length - 1].s1).toBe(99);
  for (let i = 1; i < w.length; i++) expect(w[i].s0).toBeLessThanOrEqual(w[i - 1].s1);
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

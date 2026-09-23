import { it, expect } from 'vitest';
import { normalizeToken, tokenize } from '../src/text/tokens.js';
import { parseJson3 } from '../src/text/json3.js';
import { buildSentences } from '../src/text/sentences.js';
it('normalizes tokens', () => {
  expect(normalizeToken(" Don't,")).toBe('dont'); expect(normalizeToken('—')).toBe(''); expect(normalizeToken('$10K')).toBe('10k');
});
it('tokenize splits multi-word entries', () => {
  expect(tokenize([{ w: 'hello there', start: 0, end: 1 }])).toEqual([
    { tok: 'hello', start: 0, end: 0.5 }, { tok: 'there', start: 0.5, end: 1 }]);
});
it('parses json3', () => {
  const j = { events: [
    { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'so' }, { utf8: ' the', tOffsetMs: 400 }, { utf8: ' point', tOffsetMs: 900 }] },
    { tStartMs: 3000, dDurationMs: 10, segs: [{ utf8: '\n' }] },
    { tStartMs: 3100, dDurationMs: 900, segs: [{ utf8: 'is' }] }] };
  const w = parseJson3(j);
  expect(w.map(x => x.w)).toEqual(['so', 'the', 'point', 'is']);
  expect(w[0]).toEqual({ w: 'so', start: 1, end: 1.4 });
  expect(w[2].end).toBeCloseTo(3.0); expect(w[3].end).toBeCloseTo(4.0);
});
it('builds sentences on punctuation and long gaps', () => {
  const w = [{ w: 'Hi.', start: 0, end: 0.3 }, { w: 'I', start: 0.4, end: 0.5 }, { w: 'win', start: 0.5, end: 0.8 },
             { w: 'then', start: 3, end: 3.2 }, { w: 'stop?', start: 3.2, end: 3.5 }];
  const s = buildSentences(w);
  expect(s.map(x => x.text)).toEqual(['Hi.', 'I win', 'then stop?']);
  expect(s[1]).toMatchObject({ id: 1, start: 0.4, end: 0.8, w0: 1, w1: 2 });
});

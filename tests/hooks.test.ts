import { it, expect } from 'vitest';
import { validateColdOpen, sortHooks } from '../src/hooks/hooks.js';
import type { Sentence, Hook } from '../src/types.js';

const sent = (id: number, start: number, end: number): Sentence => ({ id, text: 's' + id, start, end, w0: id * 2, w1: id * 2 + 1 });
// startSid=5, endSid=10. Sentence 7 is a normal-length (3s) sentence inside the range.
const S: Sentence[] = Array.from({ length: 20 }, (_, i) => sent(i, i * 10, i * 10 + 3));

it('validateColdOpen accepts a sentence strictly inside (start, end] with duration in [1.5, 7]s', () => {
  expect(validateColdOpen(S, 5, 10, 7)).toBe(7);
  // endSid itself is inclusive
  expect(validateColdOpen(S, 5, 10, 10)).toBe(10);
});

it('validateColdOpen rejects the clip\'s first sentence (sid === startSid)', () => {
  expect(validateColdOpen(S, 5, 10, 5)).toBeNull();
});

it('validateColdOpen rejects a sentence longer than 7s', () => {
  const long: Sentence[] = [...S];
  long[7] = { ...S[7], start: 70, end: 78.5 }; // 8.5s
  expect(validateColdOpen(long, 5, 10, 7)).toBeNull();
});

it('validateColdOpen rejects a sentence shorter than 1.5s', () => {
  const short: Sentence[] = [...S];
  short[7] = { ...S[7], start: 70, end: 71 }; // 1s
  expect(validateColdOpen(short, 5, 10, 7)).toBeNull();
});

it('validateColdOpen rejects sids outside (startSid, endSid]', () => {
  expect(validateColdOpen(S, 5, 10, 4)).toBeNull(); // before startSid
  expect(validateColdOpen(S, 5, 10, 11)).toBeNull(); // after endSid
});

it('validateColdOpen rejects null', () => {
  expect(validateColdOpen(S, 5, 10, null)).toBeNull();
});

it('sortHooks orders by score descending, stably for ties', () => {
  const hooks: Hook[] = [
    { text: 'Low score', pattern: 'p1', score: 3 },
    { text: 'High score A', pattern: 'p2', score: 9 },
    { text: 'High score B', pattern: 'p3', score: 9 },
    { text: 'Mid score', pattern: 'p4', score: 6 },
  ];
  expect(sortHooks(hooks).map((h) => h.text)).toEqual(['High score A', 'High score B', 'Mid score', 'Low score']);
});

it('sortHooks trims hook text', () => {
  const hooks: Hook[] = [{ text: '  spaced out  ', pattern: 'p1', score: 5 }];
  expect(sortHooks(hooks)).toEqual([{ text: 'spaced out', pattern: 'p1', score: 5 }]);
});

it('sortHooks drops hooks that are empty after trimming', () => {
  const hooks: Hook[] = [
    { text: '   ', pattern: 'p1', score: 9 },
    { text: 'Keep me', pattern: 'p2', score: 1 },
  ];
  expect(sortHooks(hooks).map((h) => h.text)).toEqual(['Keep me']);
});

it('sortHooks drops hooks longer than 70 chars (after trimming)', () => {
  const tooLong = 'x'.repeat(71);
  const exactly70 = 'y'.repeat(70);
  const hooks: Hook[] = [
    { text: `  ${tooLong}  `, pattern: 'p1', score: 10 },
    { text: exactly70, pattern: 'p2', score: 2 },
  ];
  expect(sortHooks(hooks).map((h) => h.text)).toEqual([exactly70]);
});

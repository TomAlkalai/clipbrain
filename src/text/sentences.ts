import type { Word, Sentence } from '../types.js';

const END_PUNCT_RE = /[.?!]["')]?$/;

export function textOf(words: Word[], w0: number, w1: number): string {
  return words.slice(w0, w1 + 1).map((w) => w.w.trim()).join(' ');
}

export function buildSentences(words: Word[], opts?: { maxGap?: number; maxWords?: number }): Sentence[] {
  const maxGap = opts?.maxGap ?? 1.2;
  const maxWords = opts?.maxWords ?? 45;
  const sentences: Sentence[] = [];
  let w0 = 0;
  let id = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const isLast = i === words.length - 1;
    const endsPunct = END_PUNCT_RE.test(w.w.trim());
    const nextGapTooLarge = !isLast && words[i + 1].start - w.end > maxGap;
    const reachedMaxWords = i - w0 + 1 >= maxWords;
    if (isLast || endsPunct || nextGapTooLarge || reachedMaxWords) {
      sentences.push({
        id: id++,
        text: textOf(words, w0, i),
        start: words[w0].start,
        end: words[i].end,
        w0,
        w1: i,
      });
      w0 = i + 1;
    }
  }
  return sentences;
}

import { it, expect } from 'vitest';
import { wordsFromCaptions } from '../src/analyze/transcribe.js';
import { parseSilencedetect } from '../src/analyze/silences.js';
it('merges sub-word tokens and drops non-speech', () => {
  expect(wordsFromCaptions([{ text: ' Hor', startMs: 0, endMs: 200 }, { text: 'mozi', startMs: 200, endMs: 400 }, { text: ' [BLANK_AUDIO]', startMs: 400, endMs: 900 }, { text: ' says.', startMs: 900, endMs: 1200 }]))
    .toEqual([{ w: 'Hormozi', start: 0, end: 0.4 }, { w: 'says.', start: 0.9, end: 1.2 }]);
});
it('does not glue words across a dropped bracket marker', () => {
  expect(wordsFromCaptions([
    { text: ' says', startMs: 0, endMs: 200 },
    { text: ' [MUSIC]', startMs: 200, endMs: 900 },
    { text: 'oops', startMs: 900, endMs: 1200 },
  ])).toEqual([{ w: 'says', start: 0, end: 0.2 }, { w: 'oops', start: 0.9, end: 1.2 }]);
});
it('does not glue words across a marker split across multiple tokens', () => {
  expect(wordsFromCaptions([
    { text: ' says', startMs: 0, endMs: 200 },
    { text: ' [', startMs: 200, endMs: 300 },
    { text: 'MUS', startMs: 300, endMs: 400 },
    { text: 'IC]', startMs: 400, endMs: 500 },
    { text: 'oops', startMs: 500, endMs: 600 },
  ])).toEqual([{ w: 'says', start: 0, end: 0.2 }, { w: 'oops', start: 0.5, end: 0.6 }]);
});
it('parses silencedetect', () => {
  const s = '[silencedetect @ 0x1] silence_start: 1.5\n[silencedetect @ 0x1] silence_end: 2.25 | silence_duration: 0.75\n[silencedetect @ 0x1] silence_start: 9\n';
  expect(parseSilencedetect(s)).toEqual([{ start: 1.5, end: 2.25 }]);
});

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

// Review finding (HANDOFF #3, local-file input): a phone video stored landscape with a 90° display
// rotation was recorded with its coded (landscape) size, while ffmpeg auto-rotates every proxy /
// hi-res transcode to portrait — so srcAspect disagreed with the actual frames. Audio-only files
// passed ingest and failed later with an unclear ffmpeg error. (JSON shapes from real ffprobe 6.1.)
import { parseProbe } from '../src/ingest.js';
it('parseProbe: plain landscape video', () => {
  expect(parseProbe({ streams: [{ width: 1920, height: 1080, tags: {} }, { tags: {} }], format: { duration: '3600.5' } }))
    .toEqual({ width: 1920, height: 1080, durationSec: 3600.5 });
});
it('parseProbe: a ±90°/270° display rotation swaps to the displayed size', () => {
  const rot = (r: number) => ({ streams: [{ width: 640, height: 360, tags: {}, side_data_list: [{ rotation: r }] }], format: { duration: '2.0' } });
  expect(parseProbe(rot(90))).toMatchObject({ width: 360, height: 640 });
  expect(parseProbe(rot(-90))).toMatchObject({ width: 360, height: 640 });
  expect(parseProbe(rot(270))).toMatchObject({ width: 360, height: 640 });
  expect(parseProbe(rot(180))).toMatchObject({ width: 640, height: 360 });
  expect(parseProbe({ streams: [{ width: 640, height: 360, tags: { rotate: '90' } }], format: {} })).toMatchObject({ width: 360, height: 640 });
});
it('parseProbe: an audio-only file is rejected with a clear error', () => {
  expect(() => parseProbe({ streams: [{}], format: { duration: '2.0' } }, 'talk.m4a')).toThrow(/no video stream in talk\.m4a/);
});

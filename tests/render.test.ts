import { it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { startStaticServer } from '../src/render/static.js';
import { parseLoudnorm, parseEbur128Summary, masterRetryPlan, truncateEdl } from '../src/render/render.js';
import type { Edl } from '../src/types.js';
it('serves byte ranges', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-')); fs.writeFileSync(path.join(d, 'a.mp4'), Buffer.from('0123456789'));
  const s = await startStaticServer(d);
  const r = await fetch(`${s.url}/a.mp4`, { headers: { Range: 'bytes=2-5' } });
  expect(r.status).toBe(206); expect(await r.text()).toBe('2345'); expect(r.headers.get('content-range')).toBe('bytes 2-5/10');
  expect((await fetch(`${s.url}/../x`)).status).toBeGreaterThanOrEqual(400);
  await s.close();
});
it('parses loudnorm json', () => {
  const e = 'blah\n[Parsed_loudnorm_0 @ 0x]\n{\n"input_i" : "-20.51",\n"input_tp" : "-3.20",\n"input_lra" : "5.10",\n"input_thresh" : "-30.9",\n"target_offset" : "0.3"\n}\n';
  expect(parseLoudnorm(e)).toEqual({ input_i: -20.51, input_tp: -3.2, input_lra: 5.1, input_thresh: -30.9, target_offset: 0.3 });
});

const EBUR128_SAMPLE =
  '[Parsed_ebur128_0 @ 0x] t: 143.98 TARGET:-23 LUFS M: -18.3 S: -14.4 I: -14.9 LUFS LRA: 3.9 LU FTPK: -3.4 dBFS TPK: -0.5 dBFS\n' +
  '[Parsed_ebur128_0 @ 0x] Summary:\n\n' +
  '  Integrated loudness:\n' +
  '    I:         -14.9 LUFS\n' +
  '    Threshold: -25.3 LUFS\n\n' +
  '  Loudness range:\n' +
  '    LRA:         3.9 LU\n' +
  '    Threshold: -35.3 LUFS\n' +
  '    LRA low:   -17.4 LUFS\n' +
  '    LRA high:  -13.5 LUFS\n\n' +
  '  True peak:\n' +
  '    Peak:       -0.5 dBFS\n';

it('parses ebur128 summary (post-encode measurement)', () => {
  expect(parseEbur128Summary(EBUR128_SAMPLE)).toEqual({ integratedLufs: -14.9, truePeakDbtp: -0.5 });
});

it('masterRetryPlan accepts a delivered file within spec', () => {
  expect(masterRetryPlan({ integratedLufs: -14.0, truePeakDbtp: -1.2 }, false)).toEqual({ action: 'accept' });
});
it('masterRetryPlan retries once at TP -3.0 when the true peak is too hot', () => {
  expect(masterRetryPlan({ integratedLufs: -14.9, truePeakDbtp: -0.5 }, false)).toEqual({ action: 'retry', tp: -3.0 });
});
it('masterRetryPlan retries once when integrated loudness drifts outside -15.5..-12.5', () => {
  expect(masterRetryPlan({ integratedLufs: -17.0, truePeakDbtp: -1.5 }, false)).toEqual({ action: 'retry', tp: -3.0 });
});
it('masterRetryPlan fails (does not loop) when still out of spec after the retry', () => {
  const plan = masterRetryPlan({ integratedLufs: -14.9, truePeakDbtp: -0.5 }, true);
  expect(plan.action).toBe('fail');
  if (plan.action === 'fail') expect(plan.reason).toMatch(/-14\.9|-0\.5/);
});

const baseEdl: Edl = {
  fps: 30, width: 1080, height: 1920, videoSrc: 'x.mp4', srcAspect: 16 / 9,
  segments: [{ srcStart: 0, srcEnd: 10, layout: { kind: 'fit' } }, { srcStart: 20, srcEnd: 40, layout: { kind: 'fit' } }],
  captions: [{ start: 0, end: 5, words: [] }, { start: 12, end: 18, words: [] }, { start: 16, end: 20, words: [] }],
  hook: { text: 'hi', start: 0, end: 3 },
  durationSec: 30, style: 'default',
};
it('truncateEdl trims segments/captions/hook to the first N seconds', () => {
  const t = truncateEdl(baseEdl, 15);
  expect(t.durationSec).toBe(15);
  expect(t.segments).toEqual([{ srcStart: 0, srcEnd: 10, layout: { kind: 'fit' } }, { srcStart: 20, srcEnd: 25, layout: { kind: 'fit' } }]);
  expect(t.captions).toEqual([{ start: 0, end: 5, words: [] }, { start: 12, end: 15, words: [] }]);
  expect(t.hook).toEqual({ text: 'hi', start: 0, end: 3 });
});
it('truncateEdl also clips the hook end when it exceeds the truncated duration', () => {
  const t = truncateEdl(baseEdl, 2);
  expect(t.durationSec).toBe(2);
  expect(t.hook).toEqual({ text: 'hi', start: 0, end: 2 });
});

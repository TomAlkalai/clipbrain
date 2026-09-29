import { it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { startStaticServer } from '../src/render/static.js';
import { parseLoudnorm, parseEbur128Summary, masterRetryPlan, truncateEdl, fetchAndReplaceHires, renameWithRetry, sweepStaleHiresTmp, RENAME_RETRY_DELAYS_MS, STALE_HIRES_TMP_MS } from '../src/render/render.js';
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

// ---- Bug 2 (important): a stale hi-res file is reused after the clip window grows ----
// Root cause: `ensureHires`'s YouTube branch called `downloadSection(url, start, end, hiresPath)`
// straight onto an EXISTING hires.mp4. yt-dlp skips the download ("has already been downloaded"),
// so the old, shorter file stays — and the very next duration check throws
// "does not match expected window" forever, because the file never actually gets replaced.
// `fetchAndReplaceHires` downloads to a fresh temp path in the same dir, verifies its duration,
// and only then atomically renames it over hiresPath — with `download`/`probeDuration` injected
// so this is testable with no network and no real media files.
function mkTmpClipDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cb-hires-'));
}
function tmpLeftovers(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
}

it('fetchAndReplaceHires: downloads to a temp path (never the final path) and renames it into place on success', async () => {
  const dir = mkTmpClipDir();
  const hiresPath = path.join(dir, 'hires.mp4');
  let downloadedTo = '';
  await fetchAndReplaceHires(
    hiresPath,
    10,
    20,
    async (start, end, outPath) => {
      expect(start).toBe(10);
      expect(end).toBe(20);
      downloadedTo = outPath;
      fs.writeFileSync(outPath, 'FRESH');
    },
    async () => 10, // matches expected window (20 - 10)
  );
  expect(fs.readFileSync(hiresPath, 'utf8')).toBe('FRESH');
  expect(downloadedTo).not.toBe(hiresPath);
  expect(path.basename(downloadedTo)).toMatch(/^hires\.tmp-.+\.mp4$/);
  expect(fs.existsSync(downloadedTo)).toBe(false); // renamed away, not left behind
  expect(tmpLeftovers(dir)).toEqual([]);
});

it('fetchAndReplaceHires: replaces a stale, too-short existing hires.mp4 instead of leaving it in place', () => {
  const dir = mkTmpClipDir();
  const hiresPath = path.join(dir, 'hires.mp4');
  fs.writeFileSync(hiresPath, 'STALE-129s');
  return fetchAndReplaceHires(
    hiresPath,
    0,
    131.14,
    async (_s, _e, outPath) => fs.writeFileSync(outPath, 'FRESH-131s'),
    async () => 131.14,
  ).then(() => {
    expect(fs.readFileSync(hiresPath, 'utf8')).toBe('FRESH-131s');
    expect(tmpLeftovers(dir)).toEqual([]);
  });
});

it('fetchAndReplaceHires: leaves the existing hires.mp4 untouched and cleans up the temp file when the downloaded duration mismatches', async () => {
  const dir = mkTmpClipDir();
  const hiresPath = path.join(dir, 'hires.mp4');
  fs.writeFileSync(hiresPath, 'ORIGINAL');
  await expect(
    fetchAndReplaceHires(
      hiresPath,
      0,
      131.14,
      async (_s, _e, outPath) => fs.writeFileSync(outPath, 'TOO-SHORT'),
      async () => 129.13,
    ),
  ).rejects.toThrow(/does not match expected window/);
  expect(fs.readFileSync(hiresPath, 'utf8')).toBe('ORIGINAL');
  expect(tmpLeftovers(dir)).toEqual([]);
});

it('fetchAndReplaceHires: leaves the existing hires.mp4 untouched and cleans up the temp file when the download itself fails', async () => {
  const dir = mkTmpClipDir();
  const hiresPath = path.join(dir, 'hires.mp4');
  fs.writeFileSync(hiresPath, 'ORIGINAL');
  await expect(
    fetchAndReplaceHires(
      hiresPath,
      0,
      10,
      async () => { throw new Error('yt-dlp network failure'); },
      async () => 10,
    ),
  ).rejects.toThrow('yt-dlp network failure');
  expect(fs.readFileSync(hiresPath, 'utf8')).toBe('ORIGINAL');
  expect(tmpLeftovers(dir)).toEqual([]);
});

it('fetchAndReplaceHires: creates the clip dir when it does not exist yet, and succeeds when there is no existing hires.mp4', async () => {
  const dir = mkTmpClipDir();
  const clipDir = path.join(dir, 'clip_new');
  const hiresPath = path.join(clipDir, 'hires.mp4');
  await fetchAndReplaceHires(
    hiresPath,
    0,
    5,
    async (_s, _e, outPath) => fs.writeFileSync(outPath, 'FIRST'),
    async () => 5,
  );
  expect(fs.readFileSync(hiresPath, 'utf8')).toBe('FIRST');
});

// ---- HANDOFF #1: Windows file locks on the hires.mp4 rename + stale temp files ----
// On Windows, renaming over hires.mp4 fails with EBUSY/EPERM (or EACCES) while another process
// still has it open — e.g. Remotion's compositor shortly after the previous render, a video
// player or an antivirus scan. The rename used to fail at once and discard a good download.
// rename/sleep/now are injected so this runs with no real locks and no real waiting.
const lockErr = (code: string) => Object.assign(new Error(`${code}: resource busy or locked, rename`), { code, syscall: 'rename' });
const flakyRename = (codes: string[]) => {
  let calls = 0;
  return {
    get calls() { return calls; },
    rename: (from: string, to: string) => {
      const code = codes[calls++];
      if (code) throw lockErr(code);
      fs.renameSync(from, to);
    },
  };
};

it('renameWithRetry: retries EBUSY/EPERM/EACCES with backoff, then renames', async () => {
  const dir = mkTmpClipDir();
  fs.writeFileSync(path.join(dir, 'a'), 'A');
  const r = flakyRename(['EBUSY', 'EPERM', 'EACCES']);
  const slept: number[] = [];
  await renameWithRetry(path.join(dir, 'a'), path.join(dir, 'b'), { rename: r.rename, sleep: async (ms) => { slept.push(ms); } });
  expect(fs.readFileSync(path.join(dir, 'b'), 'utf8')).toBe('A');
  expect(r.calls).toBe(4);
  expect(slept).toEqual(RENAME_RETRY_DELAYS_MS.slice(0, 3));
  expect(slept).toEqual([...slept].sort((x, y) => x - y)); // backoff never shrinks
});

it('renameWithRetry: does not retry errors that are not file locks', async () => {
  const slept: number[] = [];
  await expect(renameWithRetry('/x', '/y', {
    rename: () => { throw Object.assign(new Error('EXDEV: cross-device link'), { code: 'EXDEV' }); },
    sleep: async (ms) => { slept.push(ms); },
  })).rejects.toThrow(/EXDEV/);
  expect(slept).toEqual([]);
});

it('renameWithRetry: gives up after the last backoff step with a clear "locked" error', async () => {
  const slept: number[] = [];
  let calls = 0;
  await expect(renameWithRetry('/x', '/y', {
    rename: () => { calls++; throw lockErr('EBUSY'); },
    sleep: async (ms) => { slept.push(ms); },
    delaysMs: [1, 2, 3],
  })).rejects.toThrow(/\/y is locked by another process \(EBUSY\) after 4 attempts/);
  expect(calls).toBe(4);
  expect(slept).toEqual([1, 2, 3]);
});

it('fetchAndReplaceHires: keeps a good download when hires.mp4 is briefly locked', async () => {
  const dir = mkTmpClipDir();
  const hiresPath = path.join(dir, 'hires.mp4');
  fs.writeFileSync(hiresPath, 'STALE');
  const r = flakyRename(['EBUSY', 'EBUSY']);
  await fetchAndReplaceHires(hiresPath, 0, 10, async (_s, _e, out) => fs.writeFileSync(out, 'FRESH'), async () => 10,
    { rename: r.rename, sleep: async () => {} });
  expect(fs.readFileSync(hiresPath, 'utf8')).toBe('FRESH');
  expect(r.calls).toBe(3);
  expect(tmpLeftovers(dir)).toEqual([]);
});

it('fetchAndReplaceHires: when the lock never clears, leaves hires.mp4 untouched and cleans up', async () => {
  const dir = mkTmpClipDir();
  const hiresPath = path.join(dir, 'hires.mp4');
  fs.writeFileSync(hiresPath, 'ORIGINAL');
  await expect(fetchAndReplaceHires(hiresPath, 0, 10, async (_s, _e, out) => fs.writeFileSync(out, 'FRESH'), async () => 10,
    { rename: () => { throw lockErr('EPERM'); }, sleep: async () => {}, retryDelaysMs: [1] })).rejects.toThrow(/locked/);
  expect(fs.readFileSync(hiresPath, 'utf8')).toBe('ORIGINAL');
  expect(tmpLeftovers(dir)).toEqual([]);
});

it('fetchAndReplaceHires: a failed download also removes its own yt-dlp intermediates', async () => {
  const dir = mkTmpClipDir();
  const hiresPath = path.join(dir, 'hires.mp4');
  await expect(fetchAndReplaceHires(hiresPath, 0, 10, async (_s, _e, out) => {
    const base = out.replace(/\.mp4$/, '');
    fs.writeFileSync(`${base}.f137.mp4.part`, 'partial video');
    fs.writeFileSync(`${base}.f140.m4a`, 'audio');
    throw new Error('yt-dlp: Failed to fetch');
  }, async () => 10)).rejects.toThrow('Failed to fetch');
  expect(tmpLeftovers(dir)).toEqual([]);
});

it('sweepStaleHiresTmp: removes old hires.tmp-* leftovers (incl. yt-dlp intermediates), keeps fresh ones and everything else', () => {
  const dir = mkTmpClipDir();
  const now = Date.now();
  const old = (now - STALE_HIRES_TMP_MS - 60_000) / 1000;
  const files = ['hires.tmp-aaa.mp4', 'hires.tmp-bbb.f137.mp4.part', 'hires.tmp-bbb.f140.m4a', 'hires.tmp-new.mp4', 'hires.mp4', 'render.mp4', 'clip.json'];
  for (const f of files) fs.writeFileSync(path.join(dir, f), f);
  for (const f of files.filter((x) => x !== 'hires.tmp-new.mp4')) fs.utimesSync(path.join(dir, f), old, old);
  expect(sweepStaleHiresTmp(dir, now).sort()).toEqual(['hires.tmp-aaa.mp4', 'hires.tmp-bbb.f137.mp4.part', 'hires.tmp-bbb.f140.m4a']);
  expect(fs.readdirSync(dir).sort()).toEqual(['clip.json', 'hires.mp4', 'hires.tmp-new.mp4', 'render.mp4']);
});

it('sweepStaleHiresTmp: a missing dir is a no-op', () => {
  expect(sweepStaleHiresTmp(path.join(mkTmpClipDir(), 'nope'), Date.now())).toEqual([]);
});

it('fetchAndReplaceHires: sweeps stale temp files left by an earlier hard-killed run', async () => {
  const dir = mkTmpClipDir();
  const hiresPath = path.join(dir, 'hires.mp4');
  fs.writeFileSync(path.join(dir, 'hires.tmp-dead.mp4'), 'orphan');
  const now = Date.now() + STALE_HIRES_TMP_MS + 60_000;
  await fetchAndReplaceHires(hiresPath, 0, 5, async (_s, _e, out) => fs.writeFileSync(out, 'FRESH'), async () => 5, { now: () => now });
  expect(fs.readFileSync(hiresPath, 'utf8')).toBe('FRESH');
  expect(tmpLeftovers(dir)).toEqual([]);
});

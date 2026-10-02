import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { bundle } from '@remotion/bundler';
import { makeCancelSignal, openBrowser, renderMedia, selectComposition, type HeadlessBrowser } from '@remotion/renderer';
import { ROOT, DATA } from '../config.js';
import { ffmpeg, ffprobe } from '../tools/bins.js';
import { run, runOk } from '../tools/proc.js';
import { downloadSection } from '../yt/ytdlp.js';
import { paths, loadClip, saveClip } from '../store.js';
import { log } from '../log.js';
import { startStaticServer } from './static.js';
import { renderTimeouts, withRenderWatchdog, type RenderTimeouts } from './watchdog.js';
import type { Clip, Edl, EdlCaption, EdlSegment, Source } from '../types.js';

// The webpack bundle of remotion/index.ts is process-lifetime cacheable — every renderClip()
// call reuses it instead of re-bundling. A rejected bundle attempt must NOT stay cached: a
// transient failure (e.g. a busy port, a one-off webpack hiccup) would otherwise permanently
// fail every subsequent renderClip() call for the rest of the process's lifetime.
let bundleLocationPromise: Promise<string> | undefined;

function getBundleLocation(): Promise<string> {
  if (!bundleLocationPromise) {
    bundleLocationPromise = bundle({ entryPoint: path.join(ROOT, 'remotion', 'index.ts') }).catch((err) => {
      bundleLocationPromise = undefined;
      throw err;
    });
  }
  return bundleLocationPromise;
}

// Fix round 1 (concurrency experiment, see task-12-report.md): measured a 20s truncated render at
// Remotion's own default concurrency vs an explicit concurrency=6 on this machine — the default
// was measurably faster (69.3s vs 71.7s), so `concurrency` is deliberately left unset below and
// Remotion's own (CPU-core-based) heuristic is used.

// A Chrome headless shell cached for a sibling project on this machine (same Remotion version).
// Reused here to avoid a redundant browser download; falls back to Remotion's own resolution
// (which downloads one — approved) when it isn't present.
const CACHED_CHROME_HEADLESS_SHELL =
  'C:\\Users\\tomal\\moon-build\\node_modules\\.remotion\\chrome-headless-shell\\win64\\chrome-headless-shell-win64\\chrome-headless-shell.exe';

function browserExecutable(): string | undefined {
  return fs.existsSync(CACHED_CHROME_HEADLESS_SHELL) ? CACHED_CHROME_HEADLESS_SHELL : undefined;
}

async function probeDuration(file: string): Promise<number> {
  const r = await runOk(ffprobe(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file]);
  const j = JSON.parse(r.stdout);
  return Number(j.format?.duration ?? 0);
}

export type DownloadHires = (windowStart: number, windowEnd: number, outPath: string) => Promise<void>;
export type ProbeDurationFn = (file: string) => Promise<number>;

const HIRES_DURATION_TOLERANCE_SEC = 0.6;

// Every ffmpeg/ffprobe step after the Chrome render (loudness passes, measurement, pixel-format
// probe, poster) gets a kill-on-timeout, so post-processing can't hang a render either. Each
// step takes seconds on a ~2-minute clip; this is a backstop, not a budget.
const FFMPEG_STEP_TIMEOUT_MS = 10 * 60_000;

// Windows reports a rename over a file another process still has open as EBUSY or EPERM (and
// EACCES in some sharing-violation cases — graceful-fs retries the same three). Holders are
// transient: Remotion's compositor right after the previous render, a video player, an AV scan.
const FILE_LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
/** Backoff between rename attempts (~6.3 s in total before giving up). */
export const RENAME_RETRY_DELAYS_MS = [100, 200, 400, 800, 1600, 3200];

const HIRES_TMP_PREFIX = 'hires.tmp-';
/**
 * A `hires.tmp-*` file older than this is an orphan from a hard-killed run. Twice yt-dlp's
 * 15-min section-download timeout (SECTION_TIMEOUT_MS in yt/ytdlp.ts), and yt-dlp keeps
 * touching its in-flight files, so a live download from another process is never swept.
 */
export const STALE_HIRES_TMP_MS = 30 * 60 * 1000;

export type RenameFn = (from: string, to: string) => void;
export type SleepFn = (ms: number) => Promise<void>;
/** Injected in tests; production uses the real fs, timers and clock. */
export type HiresFsDeps = { rename?: RenameFn; sleep?: SleepFn; retryDelaysMs?: number[]; now?: () => number };

const realSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function lockCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && FILE_LOCK_CODES.has(code) ? code : null;
}

/**
 * `rename(from, to)`, retried with backoff while `to` is locked by another process. Any other
 * error is thrown at once; a lock that outlasts every retry becomes a clear "locked" error.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  o: { rename?: RenameFn; sleep?: SleepFn; delaysMs?: number[] } = {},
): Promise<void> {
  const rename = o.rename ?? fs.renameSync;
  const sleep = o.sleep ?? realSleep;
  const delays = o.delaysMs ?? RENAME_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      const code = lockCode(err);
      if (!code) throw err;
      if (attempt >= delays.length) {
        throw new Error(
          `${to} is locked by another process (${code}) after ${attempt + 1} attempts — close whatever has it open ` +
            `(a video player, Explorer preview) and retry`,
          { cause: err },
        );
      }
      log(`${path.basename(to)} is locked (${code}); retrying the rename in ${delays[attempt]} ms (${attempt + 1}/${delays.length})`);
      await sleep(delays[attempt]);
    }
  }
}

/**
 * Removes `hires.tmp-*` files in `dir` last modified more than `maxAgeMs` before `now` —
 * orphans (including yt-dlp's `.part`/`.fNNN` intermediates) from a run that was hard-killed
 * before its own cleanup ran. Returns the removed file names; a missing dir is a no-op.
 */
export function sweepStaleHiresTmp(dir: string, now: number, maxAgeMs = STALE_HIRES_TMP_MS): string[] {
  if (!fs.existsSync(dir)) return [];
  const removed: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(HIRES_TMP_PREFIX)) continue;
    const p = path.join(dir, name);
    try {
      if (now - fs.statSync(p).mtimeMs <= maxAgeMs) continue;
      fs.rmSync(p, { force: true });
      removed.push(name);
    } catch {
      // Gone already, or locked by a process that is still using it: leave it for next time.
    }
  }
  return removed;
}

/**
 * Removes every file in `dir` whose name starts with `prefix`. Best effort and never throws: it
 * runs while handling another error, which must not be masked by a cleanup failure (a temp file
 * that is itself locked is left for sweepStaleHiresTmp).
 */
function removeByPrefix(dir: string, prefix: string): void {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      // see above
    }
  }
}

/**
 * Downloads (via `download`) into a fresh temp file next to `hiresPath`, verifies its duration
 * against the expected `[windowStart, windowEnd)` window, and only then atomically renames it
 * over `hiresPath`. On any failure — the download itself, or a duration mismatch — the temp file
 * (and any yt-dlp intermediates it left) is removed and `hiresPath` (if it already existed) is
 * left untouched.
 *
 * Root-cause fix (Bug 2, important): `ensureHires`'s YouTube branch used to call
 * `downloadSection(url, start, end, hiresPath)` directly onto an EXISTING hires.mp4. yt-dlp sees
 * a file already at that exact output path and skips the download ("has already been
 * downloaded"), so after a QC fix extends the clip's window, the OLD, shorter file silently
 * stays in place — and every subsequent render fails the duration check forever, since the file
 * never actually gets replaced. Downloading to a distinct temp path first (never `hiresPath`
 * itself) means yt-dlp/ffmpeg always writes a real, fresh file, which is verified before it ever
 * replaces the one downstream code depends on.
 *
 * The final rename is retried with backoff while `hiresPath` is locked (Windows EBUSY/EPERM —
 * see renameWithRetry), so a briefly-held file no longer throws away a good download. Stale
 * `hires.tmp-*` orphans from hard-killed runs are swept first (sweepStaleHiresTmp).
 *
 * `download`/`probeDuration` (and, in tests, rename/sleep/clock via `deps`) are injected so this
 * is unit-testable with no network and no real media files (see tests/render.test.ts).
 */
export async function fetchAndReplaceHires(
  hiresPath: string,
  windowStart: number,
  windowEnd: number,
  download: DownloadHires,
  probeDuration: ProbeDurationFn,
  deps: HiresFsDeps = {},
): Promise<void> {
  const dir = path.dirname(hiresPath);
  fs.mkdirSync(dir, { recursive: true });
  const swept = sweepStaleHiresTmp(dir, (deps.now ?? Date.now)());
  if (swept.length > 0) log(`removed ${swept.length} stale hi-res temp file(s) in ${dir}: ${swept.join(', ')}`);

  const tmpBase = `${HIRES_TMP_PREFIX}${crypto.randomBytes(6).toString('hex')}`;
  const tmpPath = path.join(dir, `${tmpBase}.mp4`);
  try {
    await download(windowStart, windowEnd, tmpPath);

    const dur = await probeDuration(tmpPath);
    const expected = windowEnd - windowStart;
    if (Math.abs(dur - expected) > HIRES_DURATION_TOLERANCE_SEC) {
      throw new Error(
        `ensureHires: downloaded hires duration ${dur.toFixed(2)}s does not match expected window ${expected.toFixed(2)}s (±${HIRES_DURATION_TOLERANCE_SEC}s) for ${hiresPath}`,
      );
    }

    await renameWithRetry(tmpPath, hiresPath, { rename: deps.rename, sleep: deps.sleep, delaysMs: deps.retryDelaysMs });
  } catch (err) {
    removeByPrefix(dir, tmpBase);
    throw err;
  }
}

/**
 * Ensures `data/clips/<id>/hires.mp4` covers the window needed to render this clip (its main
 * range plus cold open, each padded by 1s, per R… see task-12 brief). Reuses the existing file
 * when it already covers the window; otherwise re-fetches it (YouTube section download, or an
 * ffmpeg re-encode for a local file source) via `fetchAndReplaceHires` (downloads to a temp file,
 * verifies, then atomically replaces `hires.mp4` — see Bug 2 fix above) and updates
 * `clip.hiresOffset` to the window start.
 */
export async function ensureHires(clip: Clip, source: Source): Promise<void> {
  const dir = paths.clip(clip.id);
  const hiresPath = path.join(dir, 'hires.mp4');

  const windowStart = Math.max(0, Math.min(clip.start, clip.coldOpen?.start ?? Infinity) - 1);
  const windowEnd = Math.max(clip.end, clip.coldOpen?.end ?? 0) + 1;

  if (fs.existsSync(hiresPath) && clip.hiresOffset <= windowStart) {
    const existingDur = await probeDuration(hiresPath);
    if (clip.hiresOffset + existingDur >= windowEnd) {
      return; // existing hires.mp4 already covers the needed window
    }
  }

  const download: DownloadHires = async (start, end, outPath) => {
    if (source.kind === 'youtube') {
      if (!source.url) throw new Error(`source ${source.id} is kind=youtube but has no url`);
      await downloadSection(source.url, start, end, outPath);
    } else {
      if (!source.filePath) throw new Error(`source ${source.id} is kind=file but has no filePath`);
      await runOk(ffmpeg(), [
        '-y',
        '-ss', String(start),
        '-to', String(end),
        '-i', source.filePath,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '16',
        '-c:a', 'aac',
        '-b:a', '192k',
        outPath,
      ]);
    }
  };

  await fetchAndReplaceHires(hiresPath, windowStart, windowEnd, download, probeDuration);
  clip.hiresOffset = windowStart;
}

export type LoudnormMeasured = {
  input_i: number;
  input_tp: number;
  input_lra: number;
  input_thresh: number;
  target_offset: number;
};

/**
 * Parses ffmpeg's `loudnorm` filter first-pass JSON report out of its stderr. ffmpeg logs other
 * lines around it (banner, `[Parsed_loudnorm_0 @ ...]`, etc.), so this scans for `{...}` blocks
 * and takes the last one — the JSON report is always printed last. Pure.
 */
export function parseLoudnorm(stderr: string): LoudnormMeasured {
  const matches = stderr.match(/\{[^{}]*\}/g);
  if (!matches || matches.length === 0) {
    throw new Error('parseLoudnorm: no JSON block found in ffmpeg stderr');
  }
  const parsed = JSON.parse(matches[matches.length - 1]);
  return {
    input_i: Number(parsed.input_i),
    input_tp: Number(parsed.input_tp),
    input_lra: Number(parsed.input_lra),
    input_thresh: Number(parsed.input_thresh),
    target_offset: Number(parsed.target_offset),
  };
}

const LOUDNESS_I = -14;
const LOUDNESS_LRA = 11;
const MASTER_TP_INITIAL = -2.0;
const MASTER_TP_RETRY = -3.0;

// Acceptance window for the *delivered* (post-AAC-encode) file, measured independently with
// ebur128 rather than trusted from loudnorm's own pre-encode estimate (see fix round 1 in
// task-12-report.md: AAC re-encoding can overshoot loudnorm's own pre-encode true-peak result by
// ~0.5 dB, so the loudnorm target itself is aimed at TP -2.0/-3.0, well below the -1.0 ceiling
// actually required of the delivered file).
const DELIVERED_TP_CEILING_DBTP = -1.0;
const DELIVERED_I_MIN_LUFS = LOUDNESS_I - 1.5;
const DELIVERED_I_MAX_LUFS = LOUDNESS_I + 1.5;

function nullSink(): string {
  return process.platform === 'win32' ? 'NUL' : '/dev/null';
}

/**
 * Runs ffmpeg's two-pass loudnorm (pass 1 measures, pass 2 applies `linear=true` using those
 * measured values — more transparent than single-pass/dynamic normalization, though ffmpeg can
 * still fall back to dynamic mode internally when linear gain would blow the TP ceiling on a very
 * quiet input) targeting I=-14/LRA=11 and the given `tp` ceiling. Video is stream-copied; audio is
 * re-encoded to AAC 48 kHz. `+faststart` moves the moov atom to the front for progressive
 * playback/upload.
 */
async function loudnormPass(rawMp4: string, outMp4: string, tp: number): Promise<void> {
  const pass1 = await run(ffmpeg(), [
    '-y',
    '-i', rawMp4,
    '-af', `loudnorm=I=${LOUDNESS_I}:TP=${tp}:LRA=${LOUDNESS_LRA}:print_format=json`,
    '-f', 'null',
    nullSink(),
  ], { timeoutMs: FFMPEG_STEP_TIMEOUT_MS });
  if (pass1.code !== 0) {
    throw new Error(`master: loudnorm analysis pass failed (code ${pass1.code}): ${pass1.stderr.slice(-2000)}`);
  }
  const measured = parseLoudnorm(pass1.stderr);

  const af =
    `loudnorm=I=${LOUDNESS_I}:TP=${tp}:LRA=${LOUDNESS_LRA}` +
    `:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}` +
    `:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true:print_format=summary`;

  fs.mkdirSync(path.dirname(outMp4), { recursive: true });
  await runOk(ffmpeg(), [
    '-y',
    '-i', rawMp4,
    '-af', af,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-movflags', '+faststart',
    outMp4,
  ], { timeoutMs: FFMPEG_STEP_TIMEOUT_MS });
}

/**
 * Parses ffmpeg's `ebur128` filter summary (with `peak=true`) out of its stderr — used to measure
 * the *delivered* file directly (post-AAC-encode), independent of whatever loudnorm assumed while
 * producing it. Scans from the last `Summary:` marker (ebur128 also logs a running per-frame line
 * that reuses the same field names, so anchoring on the summary block avoids matching those). Pure.
 */
export function parseEbur128Summary(stderr: string): { integratedLufs: number; truePeakDbtp: number } {
  const idx = stderr.lastIndexOf('Summary:');
  const summary = idx === -1 ? stderr : stderr.slice(idx);
  const iMatch = /Integrated loudness:\s*\n\s*I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/.exec(summary);
  const peakMatch = /True peak:\s*\n\s*Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/.exec(summary);
  if (!iMatch || !peakMatch) {
    throw new Error('parseEbur128Summary: could not find integrated loudness / true peak in ebur128 summary');
  }
  return { integratedLufs: Number(iMatch[1]), truePeakDbtp: Number(peakMatch[1]) };
}

async function measureDelivered(file: string): Promise<{ integratedLufs: number; truePeakDbtp: number }> {
  const r = await run(ffmpeg(), ['-y', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', nullSink()], { timeoutMs: FFMPEG_STEP_TIMEOUT_MS });
  if (r.code !== 0) {
    throw new Error(`master: ebur128 measurement of delivered file failed (code ${r.code}): ${r.stderr.slice(-2000)}`);
  }
  return parseEbur128Summary(r.stderr);
}

export type MasterRetryPlan = { action: 'accept' } | { action: 'retry'; tp: number } | { action: 'fail'; reason: string };

/**
 * Decides what to do about a delivered (post-encode) loudness measurement: accept it, retry once
 * (at a lower loudnorm TP ceiling, to claw back the AAC-overshoot headroom), or give up. Pure —
 * the actual re-mastering + re-measuring is done by the caller (`master`).
 */
export function masterRetryPlan(measured: { integratedLufs: number; truePeakDbtp: number }, hasRetried: boolean): MasterRetryPlan {
  const tpOk = measured.truePeakDbtp <= DELIVERED_TP_CEILING_DBTP;
  const iOk = measured.integratedLufs >= DELIVERED_I_MIN_LUFS && measured.integratedLufs <= DELIVERED_I_MAX_LUFS;
  if (tpOk && iOk) return { action: 'accept' };
  if (!hasRetried) return { action: 'retry', tp: MASTER_TP_RETRY };
  return {
    action: 'fail',
    reason:
      `master: delivered audio still out of spec after retry — integrated ${measured.integratedLufs.toFixed(1)} LUFS ` +
      `(want ${DELIVERED_I_MIN_LUFS}..${DELIVERED_I_MAX_LUFS}), true peak ${measured.truePeakDbtp.toFixed(1)} dBTP ` +
      `(want <= ${DELIVERED_TP_CEILING_DBTP})`,
  };
}

/**
 * Masters `rawMp4` to broadcast loudness, verifying the *delivered* file rather than trusting
 * loudnorm's own pre-encode estimate (AAC re-encoding can overshoot it — see fix round 1 in
 * task-12-report.md). Masters at TP -2.0 first; if the delivered file's independently-measured
 * loudness/peak still misses spec, re-masters once from `rawMp4` at TP -3.0; if it still misses
 * after that, throws (QC surfaces the failure rather than silently shipping an out-of-spec file).
 */
export async function master(rawMp4: string, outMp4: string): Promise<void> {
  await loudnormPass(rawMp4, outMp4, MASTER_TP_INITIAL);
  let measured = await measureDelivered(outMp4);
  let plan = masterRetryPlan(measured, false);
  if (plan.action === 'retry') {
    log(
      `master: delivered audio out of spec (I=${measured.integratedLufs.toFixed(1)} LUFS, TP=${measured.truePeakDbtp.toFixed(1)} dBTP) — re-mastering at TP=${plan.tp}`,
    );
    await loudnormPass(rawMp4, outMp4, plan.tp);
    measured = await measureDelivered(outMp4);
    plan = masterRetryPlan(measured, true);
  }
  if (plan.action === 'fail') throw new Error(plan.reason);
}

/**
 * Truncates an EDL to its first `maxSec` seconds of output-timeline duration — for fast local
 * iteration on a render (`cb render-test <sourceId> --max-sec N`) without waiting out a full,
 * possibly multi-minute-long clip. Keeps whole segments that fit, clips the segment straddling
 * the cutoff (shortening its `srcEnd` by exactly the overrun), drops caption pages that start at
 * or after the cutoff and clips the end of any page that straddles it, and clips the hook's end
 * the same way. Pure.
 */
export function truncateEdl(edl: Edl, maxSec: number): Edl {
  if (maxSec <= 0) throw new Error('truncateEdl: maxSec must be > 0');

  let acc = 0;
  const segments: EdlSegment[] = [];
  for (const s of edl.segments) {
    if (acc >= maxSec) break;
    const segDur = s.srcEnd - s.srcStart;
    const remaining = maxSec - acc;
    if (segDur <= remaining) {
      segments.push(s);
      acc += segDur;
    } else {
      segments.push({ srcStart: s.srcStart, srcEnd: s.srcStart + remaining, layout: s.layout });
      acc += remaining;
      break;
    }
  }
  const durationSec = Math.min(acc, maxSec);

  const captions: EdlCaption[] = edl.captions
    .filter((c) => c.start < durationSec)
    .map((c) => ({ ...c, end: Math.min(c.end, durationSec) }));

  const hook = edl.hook ? { ...edl.hook, end: Math.min(edl.hook.end, durationSec) } : null;

  return { ...edl, segments, captions, hook, durationSec };
}

const DELIVERABLE_PIX_FMT = 'yuv420p';

/**
 * Asserts the delivered file's video stream is exactly `yuv420p` — not `yuvj420p` (the
 * full-range/legacy-JPEG-range variant ffprobe reports when the encode isn't tagged with an
 * explicit limited-range color space; see fix round 1 in task-12-report.md, `colorSpace: 'bt709'`
 * on `renderMedia` is what avoids it). QC (Task 13) should apply this same strict check rather
 * than treating `yuvj420p` as an acceptable equivalent.
 */
export async function assertDeliverablePixelFormat(file: string): Promise<void> {
  const r = await runOk(ffprobe(), [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=pix_fmt',
    '-of', 'json',
    file,
  ], { timeoutMs: FFMPEG_STEP_TIMEOUT_MS });
  const j = JSON.parse(r.stdout);
  const pixFmt = j.streams?.[0]?.pix_fmt;
  if (pixFmt !== DELIVERABLE_PIX_FMT) {
    throw new Error(`assertDeliverablePixelFormat: ${file} has pix_fmt="${pixFmt}", expected exactly "${DELIVERABLE_PIX_FMT}"`);
  }
}

export type RenderBrowser = Pick<HeadlessBrowser, 'close'>;

/** What renderClip drives, injectable so the watchdog/cleanup paths are testable without Chrome. */
export type RenderDeps = {
  getBundleLocation: () => Promise<string>;
  startStaticServer: typeof startStaticServer;
  openBrowser: (executable: string | null) => Promise<RenderBrowser>;
  selectComposition: typeof selectComposition;
  renderMedia: typeof renderMedia;
  makeCancelSignal: typeof makeCancelSignal;
  master: (rawMp4: string, outMp4: string) => Promise<void>;
  assertDeliverablePixelFormat: (file: string) => Promise<void>;
  makePoster: (renderMp4: string, posterJpg: string) => Promise<void>;
  timeouts: () => RenderTimeouts;
};

async function makePoster(renderMp4: string, posterJpg: string): Promise<void> {
  await runOk(ffmpeg(), ['-y', '-ss', '1.0', '-i', renderMp4, '-frames:v', '1', '-vf', 'scale=360:-2', posterJpg], {
    timeoutMs: FFMPEG_STEP_TIMEOUT_MS,
  });
}

function defaultRenderDeps(): RenderDeps {
  return {
    getBundleLocation,
    startStaticServer,
    openBrowser: (executable) => openBrowser('chrome', { browserExecutable: executable }),
    selectComposition,
    renderMedia,
    makeCancelSignal,
    master,
    assertDeliverablePixelFormat,
    makePoster,
    timeouts: renderTimeouts,
  };
}

const TEARDOWN_TIMEOUT_MS = 30_000;

/** Runs a teardown step without letting it throw or hang the caller. */
async function teardown(what: string, fn: () => Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${TEARDOWN_TIMEOUT_MS / 1000}s`)), TEARDOWN_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    log(`warning: ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Renders a clip's EDL through the `Clip` Remotion composition and masters the audio to broadcast
 * loudness. Bundles `remotion/index.ts` once per process, serves `DATA` over a local static
 * server (Chrome fetches the EDL's hi-res video over HTTP, not file://), then:
 *   raw.mp4 (Remotion render, h264/aac) → render.mp4 (loudnorm-mastered) → poster.jpg (1s still).
 * Per controller ruling R2, raw.mp4 is kept (not deleted) — QC (Task 13) re-masters from it and
 * deletes it when finished.
 *
 * A render can never wait forever (HANDOFF open item #2: a lost Chrome connection once hung a
 * `produce` run for 5 days). The Chrome phase — launch, composition, frames — runs under
 * withRenderWatchdog: no Remotion progress for CB_RENDER_STALL_MIN (default 5) minutes, or more
 * than CB_RENDER_TIMEOUT_MIN (default 60) minutes in total, cancels renderMedia, kills this
 * render's own Chrome (opened here, so it can be closed here) and throws a RenderTimeoutError.
 * Chrome and the static server are always torn down, with a bound; the ffmpeg post-steps run
 * after that, each with a kill-on-timeout. Callers (produce, requalify, QC, the review job
 * runner) record the error on the clip and move on to the next one.
 */
export async function renderClip(clipId: string, deps: Partial<RenderDeps> = {}): Promise<void> {
  const d: RenderDeps = { ...defaultRenderDeps(), ...deps };
  const clip = loadClip(clipId);
  if (!clip.edl) throw new Error(`clip ${clipId} has no edl — build one first (buildEdl + saveClip)`);
  const edlIn = clip.edl;

  const dir = paths.clip(clipId);
  fs.mkdirSync(dir, { recursive: true });
  const rawPath = path.join(dir, 'raw.mp4');
  const renderPath = path.join(dir, 'render.mp4');

  const limits = d.timeouts();
  for (const w of limits.warnings) log(`warning: ${w}`);

  const bundleLocation = await d.getBundleLocation();
  const server = await d.startStaticServer(DATA);
  const { cancelSignal, cancel } = d.makeCancelSignal();
  let browser: RenderBrowser | null = null;
  let aborted = false;
  const closeBrowser = async () => {
    const b = browser;
    browser = null;
    if (b) await b.close({ silent: true });
  };

  const totalFrames = Math.max(1, Math.round(edlIn.durationSec * edlIn.fps));
  let stage = 'starting Chrome';
  let renderedFrames = 0;

  try {
    await withRenderWatchdog(
      async ({ progress }) => {
        const opened = await d.openBrowser(browserExecutable() ?? null);
        if (aborted) {
          // The watchdog fired while Chrome was still launching: don't leak the late browser.
          await opened.close({ silent: true }).catch(() => {});
          throw new Error('render aborted while Chrome was starting');
        }
        browser = opened;
        progress();

        stage = 'loading the composition';
        const edl: Edl = { ...edlIn, videoSrc: `${server.url}/clips/${clipId}/hires.mp4` };
        const inputProps = { edl };
        const puppeteerInstance = opened as HeadlessBrowser;
        const composition = await d.selectComposition({ serveUrl: bundleLocation, id: 'Clip', inputProps, puppeteerInstance });
        progress();

        stage = 'rendering frames';
        let lastLoggedPct = -10;
        await d.renderMedia({
          composition,
          serveUrl: bundleLocation,
          codec: 'h264',
          crf: 18,
          audioCodec: 'aac',
          pixelFormat: 'yuv420p',
          colorSpace: 'bt709',
          outputLocation: rawPath,
          inputProps,
          puppeteerInstance,
          cancelSignal,
          onProgress: (p) => {
            progress();
            renderedFrames = p.renderedFrames;
            if (p.stitchStage === 'muxing') stage = 'muxing';
            const pct = Math.floor(p.progress * 100);
            if (pct >= lastLoggedPct + 10) {
              lastLoggedPct = pct - (pct % 10);
              log(`render ${clipId}: ${lastLoggedPct}%`);
            }
          },
        });
      },
      {
        stallMs: limits.stallMs,
        hardMs: limits.hardMs,
        describe: () => `${stage}, frame ${renderedFrames}/${totalFrames}`,
        cleanup: async () => {
          aborted = true;
          cancel();
          await closeBrowser();
        },
      },
    );
  } finally {
    await teardown(`closing Chrome for ${clipId}`, closeBrowser);
    await teardown(`closing the static server for ${clipId}`, () => server.close());
  }

  await d.master(rawPath, renderPath);
  await d.assertDeliverablePixelFormat(renderPath);
  await d.makePoster(renderPath, path.join(dir, 'poster.jpg'));

  clip.renders += 1;
  clip.status = 'rendered';
  saveClip(clip);
}

import fs from 'node:fs';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { ROOT, DATA } from '../config.js';
import { ffmpeg, ffprobe } from '../tools/bins.js';
import { run, runOk } from '../tools/proc.js';
import { downloadSection } from '../yt/ytdlp.js';
import { paths, loadClip, saveClip } from '../store.js';
import { log } from '../log.js';
import { startStaticServer } from './static.js';
import type { Clip, Edl, Source } from '../types.js';

// The webpack bundle of remotion/index.ts is process-lifetime cacheable — every renderClip()
// call reuses it instead of re-bundling.
let bundleLocationPromise: Promise<string> | undefined;

function getBundleLocation(): Promise<string> {
  if (!bundleLocationPromise) {
    bundleLocationPromise = bundle({ entryPoint: path.join(ROOT, 'remotion', 'index.ts') });
  }
  return bundleLocationPromise;
}

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

/**
 * Ensures `data/clips/<id>/hires.mp4` covers the window needed to render this clip (its main
 * range plus cold open, each padded by 1s, per R… see task-12 brief). Reuses the existing file
 * when it already covers the window; otherwise re-fetches it (YouTube section download, or an
 * ffmpeg re-encode for a local file source) and updates `clip.hiresOffset` to the window start.
 * Verifies the resulting file's duration is within 0.6s of the expected window length.
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

  fs.mkdirSync(dir, { recursive: true });
  if (source.kind === 'youtube') {
    if (!source.url) throw new Error(`source ${source.id} is kind=youtube but has no url`);
    await downloadSection(source.url, windowStart, windowEnd, hiresPath);
  } else {
    if (!source.filePath) throw new Error(`source ${source.id} is kind=file but has no filePath`);
    await runOk(ffmpeg(), [
      '-y',
      '-ss', String(windowStart),
      '-to', String(windowEnd),
      '-i', source.filePath,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '16',
      '-c:a', 'aac',
      '-b:a', '192k',
      hiresPath,
    ]);
  }

  const dur = await probeDuration(hiresPath);
  const expected = windowEnd - windowStart;
  if (Math.abs(dur - expected) > 0.6) {
    throw new Error(
      `ensureHires: hires.mp4 duration ${dur.toFixed(2)}s does not match expected window ${expected.toFixed(2)}s (±0.6s) for clip ${clip.id}`,
    );
  }
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

const LOUDNESS_TARGET = { I: -14, TP: -1.0, LRA: 11 };

/**
 * Two-pass loudness mastering to −14 LUFS integrated / −1.0 dBTP / 11 LRA: pass 1 measures the
 * input with `loudnorm` in analysis mode, pass 2 applies `linear=true` normalization using those
 * measured values (more transparent than single-pass/dynamic normalization). Video is stream-
 * copied; audio is re-encoded to AAC 48 kHz. `+faststart` moves the moov atom to the front for
 * progressive playback/upload.
 */
export async function master(rawMp4: string, outMp4: string): Promise<void> {
  const nullSink = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const pass1 = await run(ffmpeg(), [
    '-y',
    '-i', rawMp4,
    '-af', `loudnorm=I=${LOUDNESS_TARGET.I}:TP=${LOUDNESS_TARGET.TP}:LRA=${LOUDNESS_TARGET.LRA}:print_format=json`,
    '-f', 'null',
    nullSink,
  ]);
  if (pass1.code !== 0) {
    throw new Error(`master: loudnorm analysis pass failed (code ${pass1.code}): ${pass1.stderr.slice(-2000)}`);
  }
  const measured = parseLoudnorm(pass1.stderr);

  const af =
    `loudnorm=I=${LOUDNESS_TARGET.I}:TP=${LOUDNESS_TARGET.TP}:LRA=${LOUDNESS_TARGET.LRA}` +
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
  ]);
}

/**
 * Renders a clip's EDL through the `Clip` Remotion composition and masters the audio to broadcast
 * loudness. Bundles `remotion/index.ts` once per process, serves `DATA` over a local static
 * server (Chrome fetches the EDL's hi-res video over HTTP, not file://), then:
 *   raw.mp4 (Remotion render, h264/aac) → render.mp4 (loudnorm-mastered) → poster.jpg (1s still).
 * Per controller ruling R2, raw.mp4 is kept (not deleted) — QC (Task 13) re-masters from it and
 * deletes it when finished.
 */
export async function renderClip(clipId: string): Promise<void> {
  const clip = loadClip(clipId);
  if (!clip.edl) throw new Error(`clip ${clipId} has no edl — build one first (buildEdl + saveClip)`);

  const dir = paths.clip(clipId);
  fs.mkdirSync(dir, { recursive: true });

  const bundleLocation = await getBundleLocation();
  const server = await startStaticServer(DATA);
  try {
    const edl: Edl = { ...clip.edl, videoSrc: `${server.url}/clips/${clipId}/hires.mp4` };
    const inputProps = { edl };
    const chrome = browserExecutable();

    const composition = await selectComposition({
      serveUrl: bundleLocation,
      id: 'Clip',
      inputProps,
      browserExecutable: chrome,
    });

    const rawPath = path.join(dir, 'raw.mp4');
    let lastLoggedPct = -10;
    await renderMedia({
      composition,
      serveUrl: bundleLocation,
      codec: 'h264',
      crf: 18,
      audioCodec: 'aac',
      pixelFormat: 'yuv420p',
      outputLocation: rawPath,
      inputProps,
      browserExecutable: chrome,
      onProgress: ({ progress }) => {
        const pct = Math.floor(progress * 100);
        if (pct >= lastLoggedPct + 10) {
          lastLoggedPct = pct - (pct % 10);
          log(`render ${clipId}: ${lastLoggedPct}%`);
        }
      },
    });

    const renderPath = path.join(dir, 'render.mp4');
    await master(rawPath, renderPath);

    const posterPath = path.join(dir, 'poster.jpg');
    await runOk(ffmpeg(), ['-y', '-ss', '1.0', '-i', renderPath, '-frames:v', '1', '-vf', 'scale=360:-2', posterPath]);

    clip.renders += 1;
    clip.status = 'rendered';
    saveClip(clip);
  } finally {
    await server.close();
  }
}

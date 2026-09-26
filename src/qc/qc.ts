import fs from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-node';
import { ffmpeg, ffprobe } from '../tools/bins.js';
import { run, runOk } from '../tools/proc.js';
import { readFrames } from '../analyze/frames.js';
import { createFaceDetector, pillarbox, type UnpadFn } from '../analyze/faces.js';
import { master, parseEbur128Summary, renderClip } from '../render/render.js';
import { llmJson } from '../llm/llm.js';
import { llmVisionJson } from '../llm/vision.js';
import { loadClip, saveClip, paths, readJsonOr } from '../store.js';
import { loadPlaybook } from '../playbook/playbook.js';
import { rebuildEdl } from '../produce.js';
import { evaluate, visionChecks, planFix, type Measures, type VisionCritique, type FixPlan } from './rules.js';
import type { Clip, Edl, QcCheck, QcReport, Sentence } from '../types.js';

function nullSink(): string {
  return process.platform === 'win32' ? 'NUL' : '/dev/null';
}

/**
 * Parses ffmpeg's `<prefix>_start`/`<prefix>_end` detector log lines out of stderr — the shared
 * shape used by `silencedetect` (two lines: `silence_start: X` / `silence_end: Y | silence_duration:
 * Z`), `blackdetect` (one line: `black_start:X black_end:Y black_duration:Z`) and `freezedetect`
 * (three lines, metadata-key-prefixed and in start/duration/end order: `lavfi.freezedetect.freeze_start:
 * X` / `lavfi.freezedetect.freeze_duration: Z` / `lavfi.freezedetect.freeze_end: Y`) — confirmed
 * against real ffmpeg 9.0 output for all three filters. Matches `<prefix>_start:`/`<prefix>_end:`
 * anywhere in the text (not anchored to line start), so the `freezedetect` metadata-key prefix
 * doesn't need special-casing, and zips starts with ends in the order each appears — an interval
 * still open at EOF (a start with no matching end) is dropped rather than guessed at. Pure.
 */
export function parseLavfiIntervals(stderr: string, prefix: 'silence' | 'black' | 'freeze'): { start: number; end: number }[] {
  const startRe = new RegExp(`${prefix}_start:\\s*(-?\\d+(?:\\.\\d+)?)`, 'g');
  const endRe = new RegExp(`${prefix}_end:\\s*(-?\\d+(?:\\.\\d+)?)`, 'g');
  const starts = [...stderr.matchAll(startRe)].map((m) => Number(m[1]));
  const ends = [...stderr.matchAll(endRe)].map((m) => Number(m[1]));
  const n = Math.min(starts.length, ends.length);
  const out: { start: number; end: number }[] = [];
  for (let i = 0; i < n; i++) out.push({ start: starts[i], end: ends[i] });
  return out;
}

/** Parses an ffprobe `r_frame_rate` string ("30/1", "30000/1001", ...) into a plain number. Pure. */
export function parseFrameRate(s: string | undefined): number {
  if (!s) return 0;
  const [n, d] = s.split('/').map(Number);
  return d ? n / d : n;
}

/** The longest caption page (by concatenated word text length) in an EDL. Pure. */
export function maxCaptionCharsOf(edl: Edl): number {
  let max = 0;
  for (const c of edl.captions) {
    const text = c.words.map((w) => w.w).join(' ');
    max = Math.max(max, text.length);
  }
  return max;
}

/** Output-timeline midpoint of each EDL segment, assuming segments play back-to-back with no
 * gaps (matches buildEdl's own output-time accumulation). Pure. */
function segmentOutputMidpoints(edl: Edl): number[] {
  let acc = 0;
  return edl.segments.map((s) => {
    const dur = s.srcEnd - s.srcStart;
    const mid = acc + dur / 2;
    acc += dur;
    return mid;
  });
}

async function probeRenderFile(file: string): Promise<Measures['probe']> {
  const r = await runOk(ffprobe(), ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]);
  const j = JSON.parse(r.stdout);
  const streams: any[] = j.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  return {
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    vcodec: v?.codec_name ?? '',
    pixFmt: v?.pix_fmt ?? '',
    fps: parseFrameRate(v?.r_frame_rate),
    acodec: a?.codec_name ?? null,
    durationSec: Number(j.format?.duration ?? 0),
  };
}

async function measureLoudness(file: string): Promise<Measures['loudness']> {
  const r = await run(ffmpeg(), ['-y', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', nullSink()]);
  if (r.code !== 0) throw new Error(`qc: ebur128 measurement failed (code ${r.code}): ${r.stderr.slice(-2000)}`);
  const { integratedLufs, truePeakDbtp } = parseEbur128Summary(r.stderr);
  return { i: integratedLufs, tp: truePeakDbtp };
}

async function measureFilters(file: string): Promise<{ silences: Measures['silences']; black: Measures['black']; freezes: Measures['freezes'] }> {
  const vf = 'blackdetect=d=0.5:pix_th=0.10,freezedetect=n=0.003:d=2.5';
  const af = 'silencedetect=noise=-40dB:d=1.2';
  const r = await run(ffmpeg(), ['-y', '-i', file, '-vf', vf, '-af', af, '-f', 'null', nullSink()]);
  if (r.code !== 0) throw new Error(`qc: filter analysis failed (code ${r.code}): ${r.stderr.slice(-2000)}`);
  return {
    silences: parseLavfiIntervals(r.stderr, 'silence'),
    black: parseLavfiIntervals(r.stderr, 'black'),
    freezes: parseLavfiIntervals(r.stderr, 'freeze'),
  };
}

const FACE_CHECK_FPS = 1;
const FACE_CHECK_WIDTH = 134;
const FACE_CHECK_HEIGHT = 240;
const ONNX_INPUT_W = 320;
const ONNX_INPUT_H = 240;

async function measureFaceChecks(clip: Clip, renderPath: string): Promise<Measures['faceChecks']> {
  const edl = clip.edl!;
  const targets = edl.segments
    .map((s, i) => ({ i, s }))
    .filter(({ s }) => s.layout.kind === 'face' && s.srcEnd - s.srcStart >= 1);
  if (targets.length === 0) return [];

  const midpoints = segmentOutputMidpoints(edl);
  const detector = await createFaceDetector();
  const results: Measures['faceChecks'] = [];

  for (const { i } of targets) {
    const mid = midpoints[i];
    let rgb: Buffer | undefined;
    for await (const frame of readFrames(renderPath, { fps: FACE_CHECK_FPS, width: FACE_CHECK_WIDTH, height: FACE_CHECK_HEIGHT, start: mid, duration: 0.05 })) {
      rgb = frame.rgb;
      break;
    }
    if (!rgb) {
      results.push({ segment: i, ok: false });
      continue;
    }
    const { data, padLeft, contentW } = pillarbox(rgb, FACE_CHECK_WIDTH, FACE_CHECK_HEIGHT);
    const tensor = new ort.Tensor('float32', data, [1, 3, ONNX_INPUT_H, ONNX_INPUT_W]);
    const unpad: UnpadFn = ({ x1, y1, x2, y2 }) => ({
      y1,
      y2,
      x1: (x1 * ONNX_INPUT_W - padLeft) / contentW,
      x2: (x2 * ONNX_INPUT_W - padLeft) / contentW,
    });
    const faces = await detector.detectTensor(tensor, unpad);
    const ok = faces.some((f) => {
      const cx = f.x + f.w / 2;
      return cx >= 0.2 && cx <= 0.8;
    });
    results.push({ segment: i, ok });
  }
  return results;
}

const CONTENT_SCHEMA = {
  type: 'object',
  required: ['standalone', 'cleanEnding', 'hookMatches', 'issues'],
  properties: {
    standalone: { type: 'boolean' },
    cleanEnding: { type: 'boolean' },
    hookMatches: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'string' } },
  },
};

const CONTENT_SYSTEM_PROMPT =
  `You are doing final content QA on a vertical Shorts clip cut from a longer podcast. You are given the ` +
  `on-screen hook text (shown for the first ~3s over the video) and the full spoken transcript of the final ` +
  `edited clip, in order. Judge honestly:\n` +
  `- standalone: could a viewer with zero other context follow this clip from its first line, with nothing ` +
  `assumed from the source episode?\n` +
  `- cleanEnding: does the clip end on a complete thought/sentence (not cut off mid-word or mid-idea)?\n` +
  `- hookMatches: does the clip's content actually deliver on what the hook promises (no clickbait mismatch)?\n` +
  `List any other concrete content problems (poor pacing, missing context, a non sequitur) in issues — an ` +
  `empty array if there are none. Do not invent issues.`;

async function measureContent(clip: Clip): Promise<NonNullable<Measures['content']>> {
  const edl = clip.edl!;
  const hook = clip.hooks[clip.hookIndex]?.text ?? null;
  const transcript = edl.captions.flatMap((c) => c.words.map((w) => w.w)).join(' ');
  const prompt = `Hook: ${hook ?? '(none)'}\n\nTranscript:\n${transcript}`;

  const result = await llmJson<{ standalone: boolean; cleanEnding: boolean; hookMatches: boolean; issues: string[] }>({
    tier: 'fast',
    purpose: 'qc-content',
    system: CONTENT_SYSTEM_PROMPT,
    prompt,
    schema: CONTENT_SCHEMA,
  });
  return {
    standalone: Boolean(result.standalone),
    cleanEnding: Boolean(result.cleanEnding),
    hookMatches: Boolean(result.hookMatches),
    issues: result.issues ?? [],
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Wraps `measureContent` so a qc-content LLM failure (after `llmJson`'s own retry) degrades to
 * `content: null` + an error message instead of crashing the whole `measure()`/`qcClip()` call
 * (controller ruling, Task 13 fix round 1). Exported for direct testing with a stubbed
 * `setBackend`.
 */
export async function measureContentSafe(clip: Clip): Promise<{ content: Measures['content']; error?: string }> {
  try {
    return { content: await measureContent(clip) };
  } catch (err) {
    return { content: null, error: errMessage(err) };
  }
}

/**
 * Measures a rendered clip's technical, audio, visual and content properties from
 * `data/clips/<id>/render.mp4`, per task-13-brief.md's exact ffmpeg invocations. `evaluate()`
 * (rules.ts) then turns this into pass/fail QcChecks. Only the qc-content LLM call degrades
 * gracefully (`content`/`contentError`) — every other measurement here still throws hard on
 * failure, same as before.
 */
export async function measure(clip: Clip): Promise<Measures> {
  if (!clip.edl) throw new Error(`measure: clip ${clip.id} has no edl`);
  const renderPath = path.join(paths.clip(clip.id), 'render.mp4');

  const [probe, loudness, filters, faceChecks, contentResult] = await Promise.all([
    probeRenderFile(renderPath),
    measureLoudness(renderPath),
    measureFilters(renderPath),
    measureFaceChecks(clip, renderPath),
    measureContentSafe(clip),
  ]);

  return {
    probe,
    loudness,
    silences: filters.silences,
    black: filters.black,
    freezes: filters.freezes,
    faceChecks,
    content: contentResult.content,
    contentError: contentResult.error,
    maxCaptionChars: maxCaptionCharsOf(clip.edl),
  };
}

// ---- Vision critique (EXTENSION) ----

const VISION_QC_SCHEMA = {
  type: 'object',
  required: ['framingOk', 'captionsReadable', 'hookReadable', 'overlaysCoverFace', 'verdict', 'improvements', 'reason'],
  properties: {
    framingOk: { type: 'boolean' },
    captionsReadable: { type: 'boolean' },
    hookReadable: { type: 'boolean' },
    overlaysCoverFace: { type: 'boolean' },
    verdict: { type: 'string', enum: ['keep', 'improve', 'reject'] },
    improvements: {
      type: 'array',
      items: { type: 'string', enum: ['fit_layout', 'next_hook', 'extend_end', 'trim_start', 'move_hook_up'] },
    },
    reason: { type: 'string' },
  },
};

const VISION_QC_SYSTEM_PROMPT =
  `You are the final visual QA gate for a vertical Shorts clip (1080x1920) before it ships. You are given 4 ` +
  `stills sampled across the rendered clip (at 0.5s, 25%, 60% and 90% of its duration, in order), the on-screen ` +
  `hook text and the full spoken transcript. Read each image file before answering. Judge:\n` +
  `- framingOk: is the subject well-framed in each still (not cut off, not tiny, not off-center)?\n` +
  `- captionsReadable: are the burned-in captions legible (not clipped, not illegible against the background)?\n` +
  `- hookReadable: is the hook overlay text legible and not covering anything important?\n` +
  `- overlaysCoverFace: true if the hook or caption overlay covers a speaker's face (eyes/forehead) in any ` +
  `still — set this whenever that's what you observe, independent of whether you also list move_hook_up below.\n` +
  `Then give an overall verdict: 'keep' (ship as-is), 'improve' (a specific fix would clearly help), or ` +
  `'reject' (fundamentally broken, not worth another fix attempt). If 'improve' or 'reject' and a fix could ` +
  `plausibly help, list which of fit_layout (switch cropped/framed segments to a full-frame fit layout), ` +
  `next_hook (try the next hook variant), extend_end (extend the clip to finish the cut-off thought), ` +
  `trim_start (trim the awkward opening) or move_hook_up (the hook box is too low and overlaps the subject's ` +
  `face — move it much higher) would help, in priority order (empty array if truly unfixable). Give a ` +
  `one-sentence reason for the verdict.`;

async function extractQcStills(renderPath: string, durationSec: number, outDir: string): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const maxT = Math.max(durationSec - 0.05, 0);
  const times = [0.5, durationSec * 0.25, durationSec * 0.6, durationSec * 0.9].map((t) => Math.min(Math.max(t, 0), maxT));
  const images: string[] = [];
  for (let i = 0; i < times.length; i++) {
    const outPath = path.join(outDir, `qc_${i}.jpg`);
    await runOk(ffmpeg(), [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', String(times[i]),
      '-i', renderPath,
      '-frames:v', '1',
      '-vf', 'scale=540:-2',
      '-q:v', '3',
      outPath,
    ]);
    images.push(outPath);
  }
  return images;
}

/**
 * The LLM-calling half of the vision critique, separated from still-extraction (`extractQcStills`,
 * real ffmpeg I/O) so it can be exercised directly — e.g. with a fabricated `images` list and a
 * stubbed `setVisionBackend` — without needing a real rendered video.
 */
export async function callVisionCritique(clip: Clip, images: string[]): Promise<VisionCritique> {
  const edl = clip.edl!;
  const hook = clip.hooks[clip.hookIndex]?.text ?? '(none)';
  const transcript = edl.captions.flatMap((c) => c.words.map((w) => w.w)).join(' ');
  const prompt =
    `Hook overlay text: ${hook}\n\n` +
    `Final transcript (in order):\n${transcript}\n\n` +
    `${images.length} stills sampled at 0.5s / 25% / 60% / 90% of the ${edl.durationSec.toFixed(1)}s clip, in order:\n` +
    images.map((p, i) => `${i + 1}. ${p}`).join('\n');

  return llmVisionJson<VisionCritique>({
    tier: 'balanced',
    purpose: 'qc-vision',
    system: VISION_QC_SYSTEM_PROMPT,
    prompt,
    schema: VISION_QC_SCHEMA,
    images,
  });
}

/**
 * Extracts 4 stills from the rendered clip (0.5s, 25%, 60%, 90%) and asks a vision-capable LLM
 * (tier `balanced`, purpose `qc-vision`) to critique the rendered output — the EXTENSION to
 * task-13-brief.md: QC judges the actual pixels, not just ffmpeg/content-transcript measurements.
 */
export async function critiqueRender(clip: Clip): Promise<VisionCritique> {
  const dir = paths.clip(clip.id);
  const renderPath = path.join(dir, 'render.mp4');
  const edl = clip.edl!;
  const outDir = path.join(dir, 'qc-stills');
  const images = await extractQcStills(renderPath, edl.durationSec, outDir);
  return callVisionCritique(clip, images);
}

/**
 * Wraps `critiqueRender` so a qc-vision failure (still-extraction or the LLM call itself, after
 * `llmVisionJson`'s own retry) degrades to `vision: null` + an error message instead of crashing
 * the whole `qcClip()` call (controller ruling, Task 13 fix round 1) — the vision-derived checks
 * are then simply omitted for that round. Exported for direct testing with a stubbed
 * `setVisionBackend`.
 */
export async function critiqueRenderSafe(clip: Clip): Promise<{ vision: VisionCritique | null; error?: string }> {
  try {
    return { vision: await critiqueRender(clip) };
  } catch (err) {
    return { vision: null, error: errMessage(err) };
  }
}

// ---- Auto-fix application (I/O) ----

/**
 * Applies a `FixPlan` that `planFix` (rules.ts) has already feasibility-checked — `extend_end`/
 * `trim_start` carry their pre-computed, already-bounds-checked `newEnd`/`newStart`, so this
 * function has nothing left to validate and no reason to decline.
 */
async function applyFixPlan(plan: FixPlan, clip: Clip): Promise<string> {
  const dir = paths.clip(clip.id);

  switch (plan.kind) {
    case 'remaster': {
      await master(path.join(dir, 'raw.mp4'), path.join(dir, 'render.mp4'));
      return `remastered audio (${plan.reason})`;
    }
    case 'fit_segments': {
      await rebuildEdl(clip, { fitSegments: plan.segments });
      await renderClip(clip.id);
      return `set segment(s) [${plan.segments.join(', ')}] to fit layout (${plan.reason})`;
    }
    case 'next_hook': {
      clip.hookIndex += 1;
      await rebuildEdl(clip);
      await renderClip(clip.id);
      return `advanced hookIndex to ${clip.hookIndex} (${plan.reason})`;
    }
    case 'extend_end': {
      clip.end = plan.newEnd;
      await rebuildEdl(clip);
      await renderClip(clip.id);
      return `extended end to ${plan.newEnd.toFixed(2)}s (${plan.reason})`;
    }
    case 'trim_start': {
      clip.start = plan.newStart;
      await rebuildEdl(clip);
      await renderClip(clip.id);
      return `trimmed start to ${plan.newStart.toFixed(2)}s (${plan.reason})`;
    }
    case 'loosen_pauses': {
      await rebuildEdl(clip, { maxPause: 0.3 });
      await renderClip(clip.id);
      return `loosened maxPause to 0.3s (${plan.reason})`;
    }
    case 'move_hook_up': {
      clip.style = 'hook-high';
      await rebuildEdl(clip);
      await renderClip(clip.id);
      return `switched style to hook-high (${plan.reason})`;
    }
  }
}

const MAX_FIX_ROUNDS = 2;

/**
 * Runs QC on a rendered clip: measure -> evaluate (+ vision critique) -> auto-fix -> re-render,
 * up to `MAX_FIX_ROUNDS` fix-and-rerender rounds (so up to `MAX_FIX_ROUNDS + 1` measure passes
 * total). A clip that still has an error-severity failure (including an unresolved vision
 * verdict — 'reject', or 'improve' that ran out of fix budget) is marked `qc_failed` with its
 * checks as the reasons; otherwise it's marked `ready`. Per controller ruling R2, `raw.mp4` is
 * deleted once QC finishes, pass or fail — `renderClip` itself keeps it (needed by the
 * loudness/true_peak remaster fix, which reruns `master()` directly from it without a full
 * re-render).
 */
export async function qcClip(clipId: string): Promise<QcReport> {
  let clip = loadClip(clipId);
  if (!clip.edl) throw new Error(`qcClip: clip ${clipId} has no edl — render it first`);

  const pb = loadPlaybook(clip.creator);
  const bounds = { minSec: pb.idealDurationSec.min, maxSec: pb.idealDurationSec.max };
  const sentences = readJsonOr<Sentence[]>(path.join(paths.source(clip.sourceId), 'sentences.json'), []);

  const fixesApplied: string[] = [];
  let checks: QcCheck[] = [];

  for (let round = 0; ; round++) {
    // measure() (technical/audio/visual/content) and critiqueRenderSafe() (vision) are
    // independent — run them concurrently. critiqueRenderSafe() never rejects (see below), so
    // this Promise.all only fails if measure() itself throws (a hard, non-LLM failure).
    const [measures, visionOutcome] = await Promise.all([measure(clip), critiqueRenderSafe(clip)]);
    const vision = visionOutcome.vision;

    const degradedChecks: QcCheck[] = [];
    if (measures.contentError) {
      degradedChecks.push({
        name: 'content_unavailable',
        ok: false,
        detail: `qc-content unavailable: ${measures.contentError}`,
        severity: 'warn',
      });
    }
    if (visionOutcome.error) {
      degradedChecks.push({
        name: 'vision_unavailable',
        ok: false,
        detail: `qc-vision unavailable: ${visionOutcome.error}`,
        severity: 'warn',
      });
    }

    checks = [...evaluate(measures, clip.edl!.durationSec), ...(vision ? visionChecks(vision) : []), ...degradedChecks];
    const ok = !checks.some((c) => c.severity === 'error' && !c.ok);

    if (ok || round >= MAX_FIX_ROUNDS) break;

    const allNonFitSegments = clip.edl!.segments.map((_, i) => i).filter((i) => clip.edl!.segments[i].layout.kind !== 'fit');
    const plan = planFix(checks, measures, vision, {
      hookIndex: clip.hookIndex,
      hookCount: clip.hooks.length,
      allNonFitSegments,
      start: clip.start,
      end: clip.end,
      minSec: bounds.minSec,
      maxSec: bounds.maxSec,
      sentences,
      style: clip.style ?? 'default',
    });
    if (!plan) break;

    const applied = await applyFixPlan(plan, clip);
    fixesApplied.push(applied);
    clip = loadClip(clipId); // pick up whatever renderClip/rebuildEdl/master persisted
  }

  const ok = !checks.some((c) => c.severity === 'error' && !c.ok);
  const report: QcReport = { ok, checks, fixesApplied, at: new Date().toISOString() };

  clip.qc = report;
  clip.status = ok ? 'ready' : 'qc_failed';
  saveClip(clip);

  const rawPath = path.join(paths.clip(clipId), 'raw.mp4');
  if (fs.existsSync(rawPath)) fs.rmSync(rawPath);

  return report;
}

import path from 'node:path';
import fs from 'node:fs';
import type { Candidate, Shot, FaceSample, FaceBox, VisualMetrics } from '../types.js';
import { planLayout } from '../edit/crop.js';
import { llmVisionJson } from '../llm/vision.js';
import { ffmpeg } from '../tools/bins.js';
import { runOk } from '../tools/proc.js';
import { paths } from '../store.js';

// Mirrors edit/crop.ts's own face-qualification and two-shot thresholds (crop.ts doesn't export
// them, and importing only `planLayout`/`cropRect` from it keeps that file's "no runtime
// imports" bundling constraint simple to reason about — it never has to know about this file).
const FACE_MIN_SCORE = 0.7;
const FACE_MIN_H = 0.06;
const TWO_SHOT_GAP_FACTOR = 0.8;

function qualifies(f: FaceBox): boolean {
  return f.score >= FACE_MIN_SCORE && f.h >= FACE_MIN_H;
}

function centerX(f: FaceBox): number {
  return f.x + f.w / 2;
}

function faceArea(f: FaceBox): number {
  return f.w * f.h;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Pure visual-fitness metrics for a candidate's [start, end] time range, computed from the
 * source's whole-episode shot-boundary scan and 1-fps face-sample scan (both already written by
 * analyze/visual.ts). This is what lets selection notice a clip that reads well on the
 * transcript but plays badly on screen: no visible subject for long stretches, a layout that
 * can't crop tight on anyone (constant "fit"), jittery cuts, or a subject too small in frame.
 * Pure.
 */
export function visualMetrics(start: number, end: number, shots: Shot[], faces: FaceSample[], srcAspect: number): VisualMetrics {
  const dur = Math.max(end - start, 1e-6);
  const samples = faces.filter((f) => f.t >= start && f.t <= end).sort((a, b) => a.t - b.t);

  const qualifyingFlags = samples.map((s) => s.faces.some(qualifies));
  const nWithFace = qualifyingFlags.filter(Boolean).length;
  const faceCoverage = samples.length > 0 ? nWithFace / samples.length : 0;

  // Samples are ~1-fps, so a run of n consecutive no-face samples is ~n seconds.
  let longestRun = 0;
  let curRun = 0;
  for (const hasFace of qualifyingFlags) {
    if (hasFace) {
      curRun = 0;
    } else {
      curRun++;
      longestRun = Math.max(longestRun, curRun);
    }
  }
  const longestNoFaceSec = longestRun;

  const cropW = 9 / 16 / srcAspect;
  let twoShotCount = 0;
  let qualifyingSamples = 0;
  const faceHeights: number[] = [];
  for (const s of samples) {
    const qs = s.faces.filter(qualifies);
    if (qs.length === 0) continue;
    qualifyingSamples++;
    const sortedByArea = [...qs].sort((a, b) => faceArea(b) - faceArea(a));
    faceHeights.push(sortedByArea[0].h);
    if (sortedByArea.length >= 2) {
      const c0 = centerX(sortedByArea[0]);
      const c1 = centerX(sortedByArea[1]);
      if (Math.abs(c0 - c1) > cropW * TWO_SHOT_GAP_FACTOR) twoShotCount++;
    }
  }
  const twoShotRatio = qualifyingSamples > 0 ? twoShotCount / qualifyingSamples : 0;
  const medianFaceH = median(faceHeights);

  // fitRatio: duration-weighted share of the range whose containing shot's own planLayout
  // (decided from that shot's own face samples) comes out "fit" — i.e. no reliable single
  // subject to crop tight on.
  let fitDur = 0;
  let coveredDur = 0;
  for (const shot of shots) {
    const segStart = Math.max(shot.start, start);
    const segEnd = Math.min(shot.end, end);
    if (segEnd <= segStart) continue;
    const shotSamples = faces.filter((f) => f.t >= shot.start && f.t <= shot.end);
    const layout = planLayout(shotSamples, srcAspect);
    const segDur = segEnd - segStart;
    coveredDur += segDur;
    if (layout.kind === 'fit') fitDur += segDur;
  }
  const fitRatio = coveredDur > 0 ? fitDur / coveredDur : 0;

  // Cuts = shot boundaries strictly inside the range (the range's own start/end aren't cuts).
  const cuts = shots.filter((s) => s.start > start && s.start < end).length;
  const cutsPerMin = (cuts / dur) * 60;

  return { faceCoverage, twoShotRatio, fitRatio, cutsPerMin, medianFaceH, longestNoFaceSec };
}

/**
 * Pure 0-10 scoring of visualMetrics, each deduction appending a human-readable issue. Metrics
 * alone (no vision LLM call needed) — visionCheck below layers on what metrics structurally
 * can't see. Pure.
 */
export function visualScore(m: VisualMetrics): { score: number; issues: string[] } {
  let score = 10;
  const issues: string[] = [];

  if (m.faceCoverage < 0.6) {
    score -= 3;
    issues.push(`face visible in only ${Math.round(m.faceCoverage * 100)}% of the clip`);
  }
  if (m.fitRatio > 0.4) {
    score -= 2;
    issues.push(`${Math.round(m.fitRatio * 100)}% of the clip has no clear subject to crop tight on`);
  }
  if (m.longestNoFaceSec > 8) {
    score -= 2;
    issues.push(`longest stretch with no visible face: ${Math.round(m.longestNoFaceSec)}s`);
  }
  if (m.cutsPerMin > 20) {
    score -= 1;
    issues.push(`jittery crop (${m.cutsPerMin.toFixed(1)} cuts/min)`);
  }
  if (m.medianFaceH < 0.12) {
    score -= 1;
    issues.push(`subject small in frame (median face height ${(m.medianFaceH * 100).toFixed(1)}%)`);
  }

  score = Math.max(0, Math.min(10, score));
  return { score, issues };
}

const VISION_SCHEMA = {
  type: 'object',
  required: ['issues'],
  properties: { issues: { type: 'array', items: { type: 'string' } } },
};

const VISION_SYSTEM_PROMPT =
  `You are a visual QA reviewer for a vertical Shorts clip cut from a longer podcast/interview. You are given ` +
  `several keyframe images, in order, sampled evenly across the clip's duration. Read each image file before ` +
  `answering.\n\n` +
  `Metrics already flag missing, tiny, or absent faces — you are looking ONLY for problems those metrics ` +
  `structurally cannot see:\n` +
  `- a burned-in ad, sponsor graphic, or lower-third overlay covering the frame\n` +
  `- a screen-share, slide deck, or other non-camera content on screen\n` +
  `- a person visibly out of frame, turned away, or not looking toward camera\n` +
  `- footage that is very dark, blown out, or blurred/out of focus\n` +
  `- a third party clearly talking off-camera (voice implied by context, not the framed subject)\n\n` +
  `Return one short, concrete issue string per real problem actually visible in these frames (e.g. "slide deck ` +
  `fills frame 2"). Return an empty array if the frames look fine — do not invent issues.`;

const N_KEYFRAMES = 4;
const KEYFRAME_WIDTH = 640;

async function extractKeyframes(proxyPath: string, start: number, end: number, outDir: string): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const dur = Math.max(end - start, 0.1);
  const images: string[] = [];
  for (let i = 0; i < N_KEYFRAMES; i++) {
    const t = start + ((i + 0.5) * dur) / N_KEYFRAMES;
    const outPath = path.join(outDir, `kf_${i}.jpg`);
    await runOk(ffmpeg(), [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', String(t),
      '-i', proxyPath,
      '-frames:v', '1',
      '-vf', `scale=${KEYFRAME_WIDTH}:-2`,
      '-q:v', '3',
      outPath,
    ]);
    images.push(outPath);
  }
  return images;
}

/**
 * Independent, cheap (tier `fast`) vision check on a candidate's own keyframes: extracts
 * `N_KEYFRAMES` evenly-spaced JPEG stills from the source's proxy.mp4 across [c.start, c.end]
 * into `framesDir/<candidateId>/`, then asks a vision-capable LLM call to read them and flag
 * anything visualMetrics can't see (burned-in ads, slides, off-camera subjects, dark/blurred
 * footage, a third party talking off-camera).
 */
export async function visionCheck(c: Candidate, framesDir: string): Promise<{ ok: boolean; issues: string[] }> {
  const proxyPath = path.join(paths.source(c.sourceId), 'proxy.mp4');
  const outDir = path.join(framesDir, c.id);
  const images = await extractKeyframes(proxyPath, c.start, c.end, outDir);

  const prompt =
    `Clip "${c.title}" — ${images.length} keyframes sampled evenly across the clip, in order:\n` +
    images.map((p, i) => `${i + 1}. ${p}`).join('\n');

  const result = await llmVisionJson<{ issues: string[] }>({
    tier: 'fast',
    purpose: 'vision',
    system: VISION_SYSTEM_PROMPT,
    prompt,
    schema: VISION_SCHEMA,
    images,
  });
  const issues = result.issues ?? [];
  return { ok: issues.length === 0, issues };
}

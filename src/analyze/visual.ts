import path from 'node:path';
import fs from 'node:fs';
import { readFrames } from './frames.js';
import { grayThumb, frameDiff, detectShots } from './shots.js';
import { createFaceDetector } from './faces.js';
import { paths, loadSource, writeJson, readJson, readJsonOr } from '../store.js';
import { log, step } from '../log.js';
import { ffmpeg } from '../tools/bins.js';
import { runOk } from '../tools/proc.js';
import type { Shot, FaceSample } from '../types.js';

const SCAN_FPS = 5;

function evenRoundedHeight(width: number, aspect: number): number {
  let h = Math.round(width / aspect);
  if (h % 2 !== 0) h += 1;
  return h;
}

export type ScanVisualOpts = { force?: boolean };
export type ScanVisualResult = { shots: number; samples: number };

/**
 * Single pass over a source's proxy.mp4 at 5 fps: every frame is reduced to a
 * gray thumbnail and diffed against the previous one (feeding shot detection);
 * every 5th frame (1 fps) also runs face detection. Writes shots.json and
 * faces.json under the source's data directory. Skips work if both already
 * exist, unless `force` is set.
 */
export async function scanVisual(sourceId: string, o?: ScanVisualOpts): Promise<ScanVisualResult> {
  const src = loadSource(sourceId);
  const dir = paths.source(sourceId);
  const proxyPath = path.join(dir, 'proxy.mp4');
  const shotsPath = path.join(dir, 'shots.json');
  const facesPath = path.join(dir, 'faces.json');

  if (!o?.force && fs.existsSync(shotsPath) && fs.existsSync(facesPath)) {
    const shots = readJsonOr<Shot[]>(shotsPath, []);
    const faces = readJsonOr<FaceSample[]>(facesPath, []);
    log(`scanVisual ${sourceId}: shots.json and faces.json already exist — skipping (use --force to redo)`);
    return { shots: shots.length, samples: faces.length };
  }

  const width = 320;
  const height = evenRoundedHeight(width, src.width / src.height);
  const durationSec = src.durationSec;

  const detectFace = await createFaceDetector();

  const diffs: { t: number; d: number }[] = [];
  const faceSamples: FaceSample[] = [];
  let prevThumb: Uint8Array | undefined;
  let frameIndex = 0;
  let lastLoggedDecile = 0;

  const done = step(`scanVisual ${sourceId} (${width}x${height} @ ${SCAN_FPS}fps, ${durationSec.toFixed(0)}s)`);

  for await (const { t, rgb } of readFrames(proxyPath, { fps: SCAN_FPS, width, height })) {
    const thumb = grayThumb(rgb, width, height);
    diffs.push({ t, d: prevThumb ? frameDiff(thumb, prevThumb) : 0 });
    prevThumb = thumb;

    if (frameIndex % SCAN_FPS === 0) {
      const faces = await detectFace(rgb, width, height);
      faceSamples.push({ t, faces });
    }
    frameIndex++;

    const decile = Math.min(10, Math.floor((t / durationSec) * 10));
    if (decile > lastLoggedDecile) {
      lastLoggedDecile = decile;
      log(`scanVisual ${sourceId}: ${decile * 10}% (t=${t.toFixed(1)}s / ${durationSec.toFixed(0)}s)`);
    }
  }

  const shots = detectShots(diffs, durationSec);
  writeJson(shotsPath, shots);
  writeJson(facesPath, faceSamples);
  done(`${shots.length} shots, ${faceSamples.length} face samples`);

  return { shots: shots.length, samples: faceSamples.length };
}

export type FaceStats = {
  shots: number;
  medianShotLen: number;
  samples: number;
  pctWithFace: number;
  pctWith2Faces: number;
};

/** Pure summary stats over already-written shots.json / faces.json. */
export function computeFaceStats(shots: Shot[], faces: FaceSample[]): FaceStats {
  const lens = shots.map((s) => s.end - s.start).sort((a, b) => a - b);
  const mid = Math.floor(lens.length / 2);
  const medianShotLen = lens.length === 0 ? 0 : lens.length % 2 === 0 ? (lens[mid - 1] + lens[mid]) / 2 : lens[mid];

  const withFace = faces.filter((f) => f.faces.length >= 1).length;
  const with2Faces = faces.filter((f) => f.faces.length >= 2).length;
  const pctWithFace = faces.length ? (100 * withFace) / faces.length : 0;
  const pctWith2Faces = faces.length ? (100 * with2Faces) / faces.length : 0;

  return { shots: shots.length, medianShotLen, samples: faces.length, pctWithFace, pctWith2Faces };
}

/** Picks up to n samples spread across the timeline, preferring ones with faces detected. */
function pickDebugSamples(faces: FaceSample[], n: number): FaceSample[] {
  const withFaces = faces.filter((f) => f.faces.length > 0);
  const pool = withFaces.length >= n ? withFaces : faces;
  if (pool.length === 0) return [];
  const picked: FaceSample[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < n; i++) {
    const idx = Math.min(pool.length - 1, Math.floor(((i + 0.5) * pool.length) / n));
    if (seen.has(idx)) continue;
    seen.add(idx);
    picked.push(pool[idx]);
  }
  return picked;
}

export type DebugSheet = { t: number; jpgPath: string; jsonPath: string; faces: FaceSample['faces'] };

/**
 * Writes up to n contact-sheet JPEGs (full proxy resolution, with detected face
 * boxes drawn on) plus a sidecar JSON listing the boxes, for visual QA.
 */
export async function writeFaceDebugSheets(sourceId: string, n = 6): Promise<DebugSheet[]> {
  const src = loadSource(sourceId);
  const dir = paths.source(sourceId);
  const proxyPath = path.join(dir, 'proxy.mp4');
  const faces = readJson<FaceSample[]>(path.join(dir, 'faces.json'));
  const debugDir = path.join(dir, 'debug');
  fs.mkdirSync(debugDir, { recursive: true });

  const outW = 640;
  const outH = evenRoundedHeight(outW, src.width / src.height);

  const samples = pickDebugSamples(faces, n);
  const sheets: DebugSheet[] = [];

  for (const sample of samples) {
    const label = sample.t.toFixed(1).replace('.', '_');
    const jpgPath = path.join(debugDir, `frame_${label}.jpg`);
    const jsonPath = path.join(debugDir, `frame_${label}.json`);

    const boxFilters = sample.faces.map((b) => {
      const x = Math.round(b.x * outW);
      const y = Math.round(b.y * outH);
      const w = Math.round(b.w * outW);
      const h = Math.round(b.h * outH);
      return `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=red@0.9:t=3`;
    });
    const vf = [`scale=${outW}:${outH}`, ...boxFilters].join(',');

    await runOk(ffmpeg(), [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      String(sample.t),
      '-i',
      proxyPath,
      '-frames:v',
      '1',
      '-vf',
      vf,
      '-q:v',
      '3',
      jpgPath,
    ]);
    writeJson(jsonPath, { t: sample.t, outW, outH, faces: sample.faces });
    sheets.push({ t: sample.t, jpgPath, jsonPath, faces: sample.faces });
  }

  return sheets;
}

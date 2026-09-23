import * as ort from 'onnxruntime-node';
import { ultrafaceModel } from '../tools/bins.js';
import type { FaceBox } from '../types.js';

const INPUT_W = 320;
const INPUT_H = 240;

export type Letterboxed = { data: Float32Array; padTop: number; contentH: number };

/**
 * Pads a 320-wide RGB24 frame into the 320x240 UltraFace input space.
 * Output is CHW float32, normalized (v-127)/128, with black padding top/bottom.
 */
export function letterbox(rgb: Buffer, w: number, h: number): Letterboxed {
  if (w !== INPUT_W) throw new Error(`letterbox expects a ${INPUT_W}-wide frame, got ${w}`);
  const contentH = h;
  const padTop = Math.floor((INPUT_H - contentH) / 2);
  const data = new Float32Array(3 * INPUT_H * INPUT_W);
  const black = (0 - 127) / 128;
  data.fill(black);

  const plane = INPUT_H * INPUT_W;
  for (let y = 0; y < contentH; y++) {
    const outY = y + padTop;
    if (outY < 0 || outY >= INPUT_H) continue;
    const rowOut = outY * INPUT_W;
    const rowSrc = y * w;
    for (let x = 0; x < INPUT_W; x++) {
      const srcIdx = (rowSrc + x) * 3;
      const outIdx = rowOut + x;
      data[outIdx] = (rgb[srcIdx] - 127) / 128;
      data[plane + outIdx] = (rgb[srcIdx + 1] - 127) / 128;
      data[2 * plane + outIdx] = (rgb[srcIdx + 2] - 127) / 128;
    }
  }
  return { data, padTop, contentH };
}

function iou(a: FaceBox, b: FaceBox): number {
  const ax2 = a.x + a.w, ay2 = a.y + a.h;
  const bx2 = b.x + b.w, by2 = b.y + b.h;
  const ix1 = Math.max(a.x, b.x), iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix1), ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const union = a.w * a.h + b.w * b.h - inter;
  return union <= 0 ? 0 : inter / union;
}

/** Greedy non-max suppression, highest score first. */
export function nms(boxes: FaceBox[], iouThresh: number): FaceBox[] {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const kept: FaceBox[] = [];
  for (const box of sorted) {
    if (kept.every((k) => iou(box, k) <= iouThresh)) kept.push(box);
  }
  return kept;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

export type FaceDetector = (rgb: Buffer, w: number, h: number) => Promise<FaceBox[]>;

/** Builds a face detector backed by the UltraFace RFB-320 ONNX model. */
export async function createFaceDetector(): Promise<FaceDetector> {
  const session = await ort.InferenceSession.create(ultrafaceModel());
  const inputName = session.inputNames[0];
  const scoresName = session.outputNames.find((n) => n.toLowerCase().includes('score')) ?? session.outputNames[0];
  const boxesName = session.outputNames.find((n) => n.toLowerCase().includes('box')) ?? session.outputNames[1];

  return async (rgb: Buffer, w: number, h: number): Promise<FaceBox[]> => {
    const { data, padTop, contentH } = letterbox(rgb, w, h);
    const tensor = new ort.Tensor('float32', data, [1, 3, INPUT_H, INPUT_W]);
    const results = await session.run({ [inputName]: tensor });
    const scores = results[scoresName].data as Float32Array;
    const boxes = results[boxesName].data as Float32Array;
    const n = boxes.length / 4;

    const raw: FaceBox[] = [];
    for (let i = 0; i < n; i++) {
      const faceScore = scores[i * 2 + 1];
      if (faceScore <= 0.7) continue;
      const x1 = boxes[i * 4];
      const y1 = boxes[i * 4 + 1];
      const x2 = boxes[i * 4 + 2];
      const y2 = boxes[i * 4 + 3];
      const fy1 = (y1 * INPUT_H - padTop) / contentH;
      const fy2 = (y2 * INPUT_H - padTop) / contentH;
      const fx1 = clamp01(x1);
      const fx2 = clamp01(x2);
      const box: FaceBox = {
        x: fx1,
        y: clamp01(fy1),
        w: Math.max(0, fx2 - fx1),
        h: Math.max(0, clamp01(fy2) - clamp01(fy1)),
        score: faceScore,
      };
      if (box.w > 0 && box.h > 0) raw.push(box);
    }
    return nms(raw, 0.3).slice(0, 8);
  };
}

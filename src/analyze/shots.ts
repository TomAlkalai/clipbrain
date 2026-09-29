import type { Shot } from '../types.js';

/** Block-average luma thumbnail (grayscale), reduced from w*h RGB24 to tw*th. */
export function grayThumb(rgb: Buffer, w: number, h: number, tw = 64, th = 36): Uint8Array {
  const out = new Uint8Array(tw * th);
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor((ty * h) / th);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * h) / th));
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor((tx * w) / tw);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * w) / tw));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1 && y < h; y++) {
        const row = y * w;
        for (let x = x0; x < x1 && x < w; x++) {
          const idx = (row + x) * 3;
          sum += 0.299 * rgb[idx] + 0.587 * rgb[idx + 1] + 0.114 * rgb[idx + 2];
          count++;
        }
      }
      out[ty * tw + tx] = count > 0 ? Math.round(sum / count) : 0;
    }
  }
  return out;
}

/** Mean absolute difference between two equal-length grayscale thumbnails. */
export function frameDiff(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  return n > 0 ? sum / n : 0;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

export type DetectShotsOpts = { minShot?: number; floor?: number; k?: number };

/**
 * Detects shot boundaries from a stream of frame-to-frame diffs.
 * Cuts when a diff spikes well above the recent local median, with a minimum
 * shot length to avoid chattering. Returns contiguous shots covering [0, durationSec].
 */
export function detectShots(diffs: { t: number; d: number }[], durationSec: number, o?: DetectShotsOpts): Shot[] {
  const minShot = o?.minShot ?? 0.6;
  const floor = o?.floor ?? 14;
  const k = o?.k ?? 4;
  const windowSize = 25;

  const cuts: number[] = [0];
  let lastCut = 0;

  for (let i = 0; i < diffs.length; i++) {
    const { t, d } = diffs[i];
    const windowStart = Math.max(0, i - windowSize);
    const window = diffs.slice(windowStart, i).map((x) => x.d);
    const threshold = Math.max(floor, k * median(window));
    if (d > threshold && t - lastCut >= minShot) {
      cuts.push(t);
      lastCut = t;
    }
  }

  const shots: Shot[] = [];
  for (let i = 0; i < cuts.length; i++) {
    const start = cuts[i];
    const end = i + 1 < cuts.length ? cuts[i + 1] : durationSec;
    if (end > start) shots.push({ start, end });
  }
  return shots;
}

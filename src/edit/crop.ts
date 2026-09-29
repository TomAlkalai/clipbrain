// NOTE: this file is bundled by webpack for the Remotion renderer as well as the CLI, so it
// must have NO runtime imports — only `import type`, which is erased at compile time.
import type { FaceBox, FaceSample, Layout, Rect } from '../types.js';

const FACE_MIN_SCORE = 0.7;
const FACE_MIN_H = 0.06;
const TWO_SHOT_GAP_FACTOR = 0.8; // fraction of cropW that two face centers must exceed to count as a two-shot
const TWO_SHOT_MIN_FRAC = 0.5; // fraction of samples that must be two-shot to choose split layout
const SMALL_FACE_H = 0.16; // below this median face height, zoom in tighter
const ZOOMED_CY_NUDGE = 0.08; // shift center down when zoomed in tight on a face
const SPLIT_ZOOM = 1.6;
const SPLIT_CY_NUDGE = 0.04;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function center(f: FaceBox): { cx: number; cy: number } {
  return { cx: f.x + f.w / 2, cy: f.y + f.h / 2 };
}

function area(f: FaceBox): number {
  return f.w * f.h;
}

function qualifies(f: FaceBox): boolean {
  return f.score >= FACE_MIN_SCORE && f.h >= FACE_MIN_H;
}

/**
 * Computes the normalized source-frame crop rect for a face/zoom pinpoint. `zoom` controls
 * how much of the source's vertical extent is shown (h = 1/zoom); the crop's width is derived
 * from the output and source aspect ratios and is never allowed to exceed the source frame's
 * width (in which case it falls back to the full frame width and a taller — i.e. more
 * source-height-limited — crop). The rect is then clamped so it stays inside [0,1]x[0,1]. Pure.
 */
export function cropRect(p: { cx: number; cy: number; zoom: number }, outAspect: number, srcAspect: number): Rect {
  let h = 1 / p.zoom;
  let w = (h * outAspect) / srcAspect;
  if (w > 1) {
    w = 1;
    h = srcAspect / outAspect;
  }
  const x = clamp(p.cx - w / 2, 0, 1 - w);
  const y = clamp(p.cy - h / 2, 0, 1 - h);
  return { x, y, w, h };
}

/**
 * Decides how to frame a piece of video from a run of face-detection samples: face-centred on
 * a single speaker, a top/bottom split for two speakers side by side, or a full "fit" (blurred
 * background) when there's no reliable single subject (no faces, or a face that moves around
 * too much to safely crop tight). An explicit `override` (e.g. a creator's fixed stream layout)
 * always wins. Pure.
 */
export function planLayout(samples: FaceSample[], srcAspect: number, override?: Layout): Layout {
  if (override) return override;

  const withQualifying = samples
    .map((s) => ({ t: s.t, faces: s.faces.filter(qualifies) }))
    .filter((s) => s.faces.length >= 1);

  if (withQualifying.length === 0) return { kind: 'fit' };

  const cropW = 9 / 16 / srcAspect;

  const twoShotPairs: { left: { cx: number; cy: number }; right: { cx: number; cy: number } }[] = [];
  const largest: { cx: number; cy: number; h: number }[] = [];

  for (const s of withQualifying) {
    const sorted = [...s.faces].sort((a, b) => area(b) - area(a));
    const top2 = sorted.slice(0, 2);
    const c0 = center(top2[0]);
    largest.push({ cx: c0.cx, cy: c0.cy, h: top2[0].h });

    if (top2.length === 2) {
      const c1 = center(top2[1]);
      if (Math.abs(c0.cx - c1.cx) > cropW * TWO_SHOT_GAP_FACTOR) {
        const [left, right] = c0.cx <= c1.cx ? [c0, c1] : [c1, c0];
        twoShotPairs.push({ left, right });
      }
    }
  }

  if (twoShotPairs.length / withQualifying.length >= TWO_SHOT_MIN_FRAC) {
    const left = { cx: median(twoShotPairs.map((p) => p.left.cx)), cy: median(twoShotPairs.map((p) => p.left.cy)) };
    const right = { cx: median(twoShotPairs.map((p) => p.right.cx)), cy: median(twoShotPairs.map((p) => p.right.cy)) };
    return {
      kind: 'split',
      top: { cx: left.cx, cy: clamp(left.cy + SPLIT_CY_NUDGE, 0, 1), zoom: SPLIT_ZOOM },
      bottom: { cx: right.cx, cy: clamp(right.cy + SPLIT_CY_NUDGE, 0, 1), zoom: SPLIT_ZOOM },
    };
  }

  const spread = Math.max(...largest.map((c) => c.cx)) - Math.min(...largest.map((c) => c.cx));
  if (spread > cropW) return { kind: 'fit' };

  const cx = median(largest.map((c) => c.cx));
  const cyFace = median(largest.map((c) => c.cy));
  const hMed = median(largest.map((c) => c.h));

  if (hMed < SMALL_FACE_H) return { kind: 'face', cx, cy: cyFace + ZOOMED_CY_NUDGE, zoom: 1.35 };
  return { kind: 'face', cx, cy: 0.5, zoom: 1 };
}

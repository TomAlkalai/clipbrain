// Pure frame-based timing/envelope helpers shared between the Remotion components
// (remotion/VideoLayer.tsx, remotion/Captions.tsx, remotion/HookOverlay.tsx) and their unit
// tests. Deliberately has ZERO runtime dependencies — no import of remotion, React, or anything
// else — so it can be imported directly from a plain vitest test without pulling in a
// browser/Node renderer stack, and so tests can exercise every input value (including the exact
// short-duration edge cases that used to crash) without needing Remotion's own `interpolate`,
// which is what threw the bug this module fixes: "inputRange must be strictly monotonically
// increasing".

/** Linear interpolation of `f` from [x0, x1] to [y0, y1], clamped at both ends. Assumes x0 < x1. */
function lerpClamped(f: number, x0: number, x1: number, y0: number, y1: number): number {
  if (f <= x0) return y0;
  if (f >= x1) return y1;
  return y0 + ((f - x0) / (x1 - x0)) * (y1 - y0);
}

/** Segments shorter than this play at flat volume (no fade) — see `segmentVolume`. */
export const MIN_FADE_SEGMENT_FRAMES = 6;

/**
 * Volume envelope for a `frames`-long video segment, evaluated at local frame `f`: fades in over
 * the first 2 frames, holds at full volume, fades out over the last 2 frames.
 *
 * Root-cause fix (Bug 1, critical): remotion/VideoLayer.tsx used to call Remotion's
 * `interpolate(f, [0, 2, frames - 2, frames], [0, 1, 1, 0], ...)` directly. That input range must
 * be strictly monotonically increasing — once `frames <= 4`, `frames - 2 <= 2`, which collides
 * with (or reverses past) the fixed `2` breakpoint (e.g. frames=3 -> [0, 2, 1, 3]), and Remotion
 * throws, crashing the whole render. Silence-aware EDL cutting (src/edit/edl.ts) can legitimately
 * produce segments this short: MIN_PIECE_SEC drops < 0.15s (4.5-frame) slivers, but cumulative
 * Sequence frame-rounding in remotion/Clip.tsx can still yield a 2-4 output-frame segment.
 * Segments under MIN_FADE_SEGMENT_FRAMES play at a flat, unfaded volume instead of computing a
 * two-sided fade that can't fit in so few frames.
 */
export function segmentVolume(f: number, frames: number): number {
  if (frames < MIN_FADE_SEGMENT_FRAMES) return 1;
  if (f <= 2) return lerpClamped(f, 0, 2, 0, 1);
  if (f >= frames - 2) return lerpClamped(f, frames - 2, frames, 1, 0);
  return 1;
}

/** Width (in frames) of the hook overlay's fade-out, anchored at its own `endFrame`. */
export const HOOK_FADE_FRAMES = 6;

/**
 * Opacity fade-out for the hook overlay, evaluated at absolute `frame`, given the hook's own
 * `startFrame`/`endFrame`.
 *
 * Audit (Bug 1 follow-up): unlike `segmentVolume`'s two-sided fade, this fade is anchored ONLY at
 * `endFrame` with a fixed-width lookback (`[endFrame - fadeFrames, endFrame]`) — there is no
 * second, duration-derived breakpoint for it to collide with, so the range stays strictly
 * increasing (as long as `fadeFrames > 0`) for any hook duration, including one that rounds to
 * under `fadeFrames` frames (e.g. a very short clip). `fadeFrames` is still clamped to the hook's
 * own visible duration below, so the fade spans the whole hook instead of mostly completing
 * before a very short hook has even fully appeared. Guarded and unit-tested down to a 0-frame
 * hook so this invariant is enforced, not just assumed.
 */
export function hookOpacity(frame: number, startFrame: number, endFrame: number, maxFadeFrames: number = HOOK_FADE_FRAMES): number {
  const fadeFrames = Math.max(1, Math.min(maxFadeFrames, endFrame - startFrame));
  return lerpClamped(frame, endFrame - fadeFrames, endFrame, 1, 0);
}

/**
 * Clamps a fixed entry-animation length (e.g. a `spring()` call's `durationInFrames`) down to an
 * element's own visible duration, so a very short-lived element (a 1-2 frame caption page, or a
 * sub-8-frame hook) never asks for an entry animation that outlives it.
 *
 * Audit (Bug 1 follow-up, Captions.tsx / HookOverlay.tsx): `spring()` takes a single scalar
 * duration, not a breakpoint array, so it has none of `interpolate`'s monotonic-range failure
 * mode — a too-short element just means the entry animation is still mid-flight when the element
 * disappears, not a crash. Clamped anyway as a correctness guard, always returning at least 1
 * frame so callers never pass `durationInFrames: 0` to `spring()`.
 */
export function entryAnimationFrames(durationFrames: number, entryFrames: number): number {
  return Math.max(1, Math.min(entryFrames, durationFrames));
}

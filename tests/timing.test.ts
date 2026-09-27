import { it, expect } from 'vitest';
import { segmentVolume, hookOpacity, entryAnimationFrames } from '../src/edit/timing.js';

// ---- Bug 1 (critical): render crash on very short segments ----
// Root cause: remotion/VideoLayer.tsx called `interpolate(f, [0, 2, frames - 2, frames], ...)`
// directly. For frames <= 4 the input range isn't strictly monotonically increasing (e.g.
// frames=3 -> [0, 2, 1, 3]), which Remotion throws on. Silence-aware EDL cutting can produce
// segments this short (edl.ts drops < 0.15s = 4.5-frame slivers, but cumulative Sequence
// rounding in Clip.tsx can still yield 2-4 output frames). segmentVolume must never build that
// unsafe range: it returns a flat, unfaded 1 for any segment under MIN_FADE_SEGMENT_FRAMES (6).

it('segmentVolume: no fade for frames=1 (flat, never dips)', () => {
  expect(segmentVolume(0, 1)).toBe(1);
});
it('segmentVolume: no fade for frames=2', () => {
  for (let f = 0; f <= 2; f++) expect(segmentVolume(f, 2)).toBe(1);
});
it('segmentVolume: no fade for frames=3', () => {
  for (let f = 0; f <= 3; f++) expect(segmentVolume(f, 3)).toBe(1);
});
it('segmentVolume: no fade for frames=4', () => {
  for (let f = 0; f <= 4; f++) expect(segmentVolume(f, 4)).toBe(1);
});
it('segmentVolume: no fade for frames=5', () => {
  for (let f = 0; f <= 5; f++) expect(segmentVolume(f, 5)).toBe(1);
});
it('segmentVolume: frames=6 fades in over [0,2] and out over [4,6], holding 1 in between', () => {
  expect(segmentVolume(0, 6)).toBe(0);
  expect(segmentVolume(1, 6)).toBe(0.5);
  expect(segmentVolume(2, 6)).toBe(1);
  expect(segmentVolume(3, 6)).toBe(1);
  expect(segmentVolume(4, 6)).toBe(1);
  expect(segmentVolume(5, 6)).toBe(0.5);
  expect(segmentVolume(6, 6)).toBe(0);
});
it('segmentVolume: frames=60 fades in over [0,2] and out over [58,60], holding 1 in the middle', () => {
  expect(segmentVolume(0, 60)).toBe(0);
  expect(segmentVolume(1, 60)).toBe(0.5);
  expect(segmentVolume(2, 60)).toBe(1);
  expect(segmentVolume(30, 60)).toBe(1);
  expect(segmentVolume(58, 60)).toBe(1);
  expect(segmentVolume(59, 60)).toBe(0.5);
  expect(segmentVolume(60, 60)).toBe(0);
});
it('segmentVolume: clamps outside [0, frames] instead of extrapolating', () => {
  expect(segmentVolume(-5, 60)).toBe(0);
  expect(segmentVolume(1000, 60)).toBe(0);
  expect(segmentVolume(-5, 2)).toBe(1);
});

// ---- Audit of Captions.tsx / HookOverlay.tsx for the same class of bug ----
// hookOpacity anchors its fade window only at `endFrame` with a fixed lookback, so unlike
// VideoLayer's two-sided fade it can't collide with a second, duration-derived breakpoint — but
// it's guarded and tested here anyway, down to a hook lasting 0-8 frames.
it('hookOpacity: fades out to 0 exactly at endFrame regardless of how short the hook is', () => {
  expect(hookOpacity(0, 0, 0)).toBe(0);
  expect(hookOpacity(1, 0, 1)).toBe(0);
  expect(hookOpacity(0, 0, 1)).toBe(1); // start of a 1-frame fade window: still fully visible
  expect(hookOpacity(2, 0, 2)).toBe(0);
  expect(hookOpacity(8, 0, 8)).toBe(0);
});
it('hookOpacity: never throws or produces NaN for endFrame from 0 to 8 (short-hook sweep)', () => {
  for (let endFrame = 0; endFrame <= 8; endFrame++) {
    for (let frame = 0; frame <= endFrame; frame++) {
      const v = hookOpacity(frame, 0, endFrame);
      expect(Number.isNaN(v)).toBe(false);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  }
});
it('hookOpacity: full opacity well before the fade window starts', () => {
  expect(hookOpacity(0, 0, 100)).toBe(1);
});

// entryAnimationFrames clamps a fixed entry-animation length (spring's durationInFrames) down to
// the element's own visible duration, so a 1-2 frame caption page (or a sub-8-frame hook) never
// asks spring to animate past a lifetime that's already over. spring() itself has no
// monotonic-range failure mode (it's a scalar duration, not a breakpoint array), so this is a
// correctness guard rather than a crash fix — verified here since the underlying logic is pure.
it('entryAnimationFrames: clamps to the element duration when shorter than the requested entry length', () => {
  expect(entryAnimationFrames(1, 6)).toBe(1);
  expect(entryAnimationFrames(2, 6)).toBe(2);
  expect(entryAnimationFrames(6, 6)).toBe(6);
});
it('entryAnimationFrames: does not stretch the entry animation past its normal length for a long element', () => {
  expect(entryAnimationFrames(300, 6)).toBe(6);
  expect(entryAnimationFrames(300, 8)).toBe(8);
});
it('entryAnimationFrames: never returns less than 1 frame, even for a zero/negative duration', () => {
  expect(entryAnimationFrames(0, 6)).toBe(1);
  expect(entryAnimationFrames(-3, 6)).toBe(1);
});

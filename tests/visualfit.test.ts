import { it, expect } from 'vitest';
import { visualMetrics, visualScore } from '../src/select/visual.js';
import type { Shot, FaceSample, FaceBox, VisualMetrics } from '../src/types.js';

const bigFace = (x: number): FaceBox => ({ x, y: 0.3, w: 0.15, h: 0.2, score: 0.9 });
const smallFace = (x: number): FaceBox => ({ x, y: 0.3, w: 0.03, h: 0.03, score: 0.9 }); // h below 0.06 threshold
const weakFace = (x: number): FaceBox => ({ x, y: 0.3, w: 0.15, h: 0.2, score: 0.3 }); // score below 0.7 threshold

it('visualMetrics: faceCoverage counts only qualifying samples (score>=0.7, h>=0.06)', () => {
  const faces: FaceSample[] = [
    { t: 0, faces: [bigFace(0.4)] }, // qualifies
    { t: 1, faces: [] }, // no face
    { t: 2, faces: [weakFace(0.4)] }, // low score -> doesn't qualify
    { t: 3, faces: [smallFace(0.4)] }, // too small -> doesn't qualify
    { t: 4, faces: [bigFace(0.4)] }, // qualifies
  ];
  const shots: Shot[] = [{ start: 0, end: 5 }];
  const m = visualMetrics(0, 5, shots, faces, 16 / 9);
  expect(m.faceCoverage).toBeCloseTo(2 / 5);
});

it('visualMetrics: longestNoFaceSec finds the longest run of consecutive no-face samples', () => {
  const faces: FaceSample[] = [
    { t: 0, faces: [bigFace(0.4)] },
    { t: 1, faces: [] },
    { t: 2, faces: [] },
    { t: 3, faces: [] },
    { t: 4, faces: [bigFace(0.4)] },
    { t: 5, faces: [] },
    { t: 6, faces: [bigFace(0.4)] },
  ];
  const shots: Shot[] = [{ start: 0, end: 7 }];
  const m = visualMetrics(0, 7, shots, faces, 16 / 9);
  expect(m.longestNoFaceSec).toBe(3);
});

it('visualMetrics: samples outside [start, end] are ignored', () => {
  const faces: FaceSample[] = [
    { t: -5, faces: [] },
    { t: 0, faces: [bigFace(0.4)] },
    { t: 1, faces: [bigFace(0.4)] },
    { t: 50, faces: [] }, // outside range, should not count toward coverage or gaps
  ];
  const m = visualMetrics(0, 2, [{ start: 0, end: 2 }], faces, 16 / 9);
  expect(m.faceCoverage).toBe(1);
  expect(m.longestNoFaceSec).toBe(0);
});

it('visualMetrics: fitRatio is the duration-weighted share of shots whose planLayout is "fit" (no qualifying faces)', () => {
  const faces: FaceSample[] = [
    // shot A [0,10): stable centered face -> 'face' layout
    { t: 1, faces: [bigFace(0.45)] },
    { t: 3, faces: [bigFace(0.46)] },
    { t: 5, faces: [bigFace(0.45)] },
    { t: 7, faces: [bigFace(0.46)] },
    { t: 9, faces: [bigFace(0.45)] },
    // shot B [10,20): no faces at all -> 'fit' layout
    { t: 11, faces: [] },
    { t: 15, faces: [] },
    { t: 19, faces: [] },
  ];
  const shots: Shot[] = [
    { start: 0, end: 10 },
    { start: 10, end: 20 },
  ];
  const m = visualMetrics(0, 20, shots, faces, 16 / 9);
  expect(m.fitRatio).toBeCloseTo(0.5);
});

it('visualMetrics: cutsPerMin counts shot boundaries strictly inside the range', () => {
  const shots: Shot[] = [
    { start: 0, end: 10 },
    { start: 10, end: 20 },
    { start: 20, end: 30 },
    { start: 30, end: 60 },
  ];
  const m = visualMetrics(0, 60, shots, [], 16 / 9);
  // boundaries at 10, 20, 30 fall strictly inside (0, 60) -> 3 cuts over 60s = 3/min
  expect(m.cutsPerMin).toBeCloseTo(3);
});

it('visualMetrics: medianFaceH is the median height of the largest qualifying face per sample', () => {
  const faces: FaceSample[] = [
    { t: 0, faces: [{ x: 0.4, y: 0.3, w: 0.1, h: 0.1, score: 0.9 }] },
    { t: 1, faces: [{ x: 0.4, y: 0.3, w: 0.1, h: 0.2, score: 0.9 }] },
    { t: 2, faces: [{ x: 0.4, y: 0.3, w: 0.1, h: 0.3, score: 0.9 }] },
  ];
  const m = visualMetrics(0, 3, [{ start: 0, end: 3 }], faces, 16 / 9);
  expect(m.medianFaceH).toBeCloseTo(0.2);
});

it('visualScore: starts at 10 and returns no issues for a clean clip', () => {
  const m: VisualMetrics = { faceCoverage: 0.9, twoShotRatio: 0, fitRatio: 0, cutsPerMin: 5, medianFaceH: 0.2, longestNoFaceSec: 2 };
  expect(visualScore(m)).toEqual({ score: 10, issues: [] });
});

it('visualScore: deducts 3 for low face coverage', () => {
  const m: VisualMetrics = { faceCoverage: 0.4, twoShotRatio: 0, fitRatio: 0, cutsPerMin: 5, medianFaceH: 0.2, longestNoFaceSec: 2 };
  const r = visualScore(m);
  expect(r.score).toBe(7);
  expect(r.issues).toHaveLength(1);
});

it('visualScore: deducts 2 for fitRatio>0.4, 2 for longestNoFaceSec>8, 1 for cutsPerMin>20, 1 for medianFaceH<0.12', () => {
  const m: VisualMetrics = { faceCoverage: 0.9, twoShotRatio: 0, fitRatio: 0.5, cutsPerMin: 25, medianFaceH: 0.05, longestNoFaceSec: 10 };
  const r = visualScore(m);
  expect(r.score).toBe(10 - 2 - 2 - 1 - 1);
  expect(r.issues).toHaveLength(4);
});

it('visualScore: clamps at the floor when every deduction applies (never goes negative)', () => {
  const m: VisualMetrics = { faceCoverage: 0, twoShotRatio: 0, fitRatio: 1, cutsPerMin: 100, medianFaceH: 0, longestNoFaceSec: 60 };
  const r = visualScore(m);
  // max total deduction is 3+2+2+1+1=9, so the floor here is 1, never below 0
  expect(r.score).toBe(1);
  expect(r.score).toBeGreaterThanOrEqual(0);
  expect(r.issues).toHaveLength(5);
});

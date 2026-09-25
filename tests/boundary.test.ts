import { it, expect } from 'vitest';
import { applyBoundaryCheck, type BoundaryCheck, type BoundaryBounds } from '../src/select/boundary.js';
import { candidateId } from '../src/select/snap.js';
import { SIGNALS } from '../src/types.js';
import type { Candidate, Scores, Sentence, Word } from '../src/types.js';

const sent = (id: number, start: number, end: number): Sentence => ({ id, text: 's' + id, start, end, w0: id * 2, w1: id * 2 + 1 });
const S: Sentence[] = Array.from({ length: 20 }, (_, i) => sent(i, i * 30, i * 30 + 28));
const W: Word[] = S.flatMap((s) => [
  { w: 'a', start: s.start, end: s.start + 10 },
  { w: 'b.', start: s.start + 10, end: s.end },
]);

function mkScores(overrides: Partial<Record<(typeof SIGNALS)[number], number>> = {}): Scores {
  return Object.fromEntries(SIGNALS.map((s) => [s, { score: overrides[s] ?? 7, reason: 'r' }])) as Scores;
}

function mkCandidate(startSid: number, endSid: number, scores = mkScores()): Candidate {
  return {
    id: `cand_${startSid}_${endSid}`,
    sourceId: 'src_1',
    startSid,
    endSid,
    start: S[startSid].start,
    end: S[endSid].end,
    title: 't',
    summary: 's',
    why: 'w',
    patterns: [],
    scores,
    composite: 7,
    shortlisted: false,
  };
}

const BOUNDS: BoundaryBounds = { minSec: 20, maxSec: 75, weights: Object.fromEntries(SIGNALS.map((s) => [s, 1])) as any };

function mkCheck(overrides: Partial<BoundaryCheck>): BoundaryCheck {
  return {
    openingStandalone: true,
    openingIssue: '',
    newStartSid: null,
    endingComplete: true,
    endingIssue: '',
    newEndSid: null,
    ...overrides,
  };
}

it('applies a repaired start when it lands within the sentence-range window and the resnapped duration stays in bounds', () => {
  const c = mkCandidate(3, 4, mkScores({ standalone_clarity: 8 }));
  const check = mkCheck({ openingStandalone: false, openingIssue: 'depends on earlier', newStartSid: 4 });
  const out = applyBoundaryCheck(c, check, S, W, BOUNDS);
  expect(out.startSid).toBe(4);
  expect(out.endSid).toBe(4);
  expect(out.start).toBeCloseTo(119.88);
  expect(out.end).toBeCloseTo(148.3);
  expect(out.boundary).toEqual({ openingStandalone: true, endingComplete: true, repaired: true, notes: expect.stringContaining('opening repaired') });
  // Repair succeeded, so the score is NOT penalized — it keeps its original value.
  expect(out.scores.standalone_clarity.score).toBe(8);
  // id is always the deterministic sha1-based formula, recomputed from the (possibly new) range —
  // never the caller-supplied placeholder id from the fixture.
  expect(out.id).toBe(candidateId('src_1', 4, 4));
});

it('rejects a repair whose resnapped duration falls outside bounds, and penalizes the score instead', () => {
  const c = mkCandidate(4, 4, mkScores({ standalone_clarity: 9 }));
  // newStartSid=1 is within [startSid-5, startSid+3] = [-1, 7], so it passes the range check,
  // but re-snapping (1,4) gives a ~118s clip against a 20-75s (->17-86.25s) bound: rejected.
  const check = mkCheck({ openingStandalone: false, openingIssue: 'depends on earlier', newStartSid: 1 });
  const out = applyBoundaryCheck(c, check, S, W, BOUNDS);
  expect(out.startSid).toBe(4); // unchanged
  expect(out.endSid).toBe(4);
  expect(out.boundary?.repaired).toBe(false);
  expect(out.boundary?.openingStandalone).toBe(false);
  expect(out.scores.standalone_clarity).toEqual({ score: 3, reason: 'boundary: depends on earlier' });
  expect(out.id).toBe(candidateId('src_1', 4, 4)); // range unchanged -> same deterministic id as the input
});

it('penalizes payoff when the ending is flagged incomplete and no repair is offered', () => {
  const c = mkCandidate(3, 4, mkScores({ payoff: 9 }));
  const check = mkCheck({ endingComplete: false, endingIssue: 'stops before the point lands', newEndSid: null });
  const out = applyBoundaryCheck(c, check, S, W, BOUNDS);
  expect(out.startSid).toBe(3);
  expect(out.endSid).toBe(4); // unchanged, no repair proposed
  expect(out.boundary).toEqual({ openingStandalone: true, endingComplete: false, repaired: false, notes: 'payoff capped at 4' });
  expect(out.scores.payoff).toEqual({ score: 4, reason: 'boundary: stops before the point lands' });
  expect(out.composite).toBeLessThan(7); // recomputed composite reflects the cap
});

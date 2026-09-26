import { it, expect } from 'vitest';
import {
  evaluate,
  visionChecks,
  planFix,
  nextSentenceEnd,
  nextSentenceStart,
  type Measures,
  type VisionCritique,
  type FixCtx,
} from '../src/qc/rules.js';
import { parseLavfiIntervals } from '../src/qc/qc.js';
import type { Sentence } from '../src/types.js';

// ---- evaluate() ----

const PASSING: Measures = {
  probe: { width: 1080, height: 1920, vcodec: 'h264', pixFmt: 'yuv420p', fps: 30, acodec: 'aac', durationSec: 30.1 },
  loudness: { i: -14.0, tp: -1.5 },
  silences: [],
  black: [],
  freezes: [],
  faceChecks: [
    { segment: 0, ok: true },
    { segment: 1, ok: true },
    { segment: 2, ok: true },
  ],
  content: { standalone: true, cleanEnding: true, hookMatches: true, issues: [] },
  maxCaptionChars: 18,
};
const EXPECTED_DURATION = 30.0;

function nameOk(checks: ReturnType<typeof evaluate>, name: string): boolean {
  const c = checks.find((c) => c.name === name);
  if (!c) throw new Error(`no check named ${name}`);
  return c.ok;
}
function severityOf(checks: ReturnType<typeof evaluate>, name: string): string {
  const c = checks.find((c) => c.name === name);
  if (!c) throw new Error(`no check named ${name}`);
  return c.severity;
}

it('evaluate: a fully-passing Measures fixture returns all ok', () => {
  const checks = evaluate(PASSING, EXPECTED_DURATION);
  expect(checks.length).toBeGreaterThan(0);
  for (const c of checks) expect(c.ok).toBe(true);
});

it('evaluate: wrong resolution fails resolution (error)', () => {
  const m: Measures = { ...PASSING, probe: { ...PASSING.probe, width: 1920, height: 1080 } };
  const checks = evaluate(m, EXPECTED_DURATION);
  expect(nameOk(checks, 'resolution')).toBe(false);
  expect(severityOf(checks, 'resolution')).toBe('error');
  // unrelated checks stay ok
  expect(nameOk(checks, 'codec')).toBe(true);
});

it('evaluate: loudness out of range fails loudness (error)', () => {
  const m: Measures = { ...PASSING, loudness: { ...PASSING.loudness, i: -20 } };
  const checks = evaluate(m, EXPECTED_DURATION);
  expect(nameOk(checks, 'loudness')).toBe(false);
  expect(severityOf(checks, 'loudness')).toBe('error');
});

it('evaluate: a 1.5s silence fails dead_air (error)', () => {
  const m: Measures = { ...PASSING, silences: [{ start: 5, end: 6.5 }] };
  const checks = evaluate(m, EXPECTED_DURATION);
  expect(nameOk(checks, 'dead_air')).toBe(false);
  expect(severityOf(checks, 'dead_air')).toBe('error');
});

it('evaluate: a sub-threshold silence (< 1.2s) does not fail dead_air', () => {
  const m: Measures = { ...PASSING, silences: [{ start: 5, end: 5.5 }] };
  const checks = evaluate(m, EXPECTED_DURATION);
  expect(nameOk(checks, 'dead_air')).toBe(true);
});

it('evaluate: faceChecks 1/3 ok fails framing (error, <60%)', () => {
  const m: Measures = {
    ...PASSING,
    faceChecks: [
      { segment: 0, ok: true },
      { segment: 1, ok: false },
      { segment: 2, ok: false },
    ],
  };
  const checks = evaluate(m, EXPECTED_DURATION);
  expect(nameOk(checks, 'framing')).toBe(false);
  expect(severityOf(checks, 'framing')).toBe('error');
});

it('evaluate: framing is not emitted when there are no face-layout segments', () => {
  const m: Measures = { ...PASSING, faceChecks: [] };
  const checks = evaluate(m, EXPECTED_DURATION);
  expect(checks.find((c) => c.name === 'framing')).toBeUndefined();
});

it('evaluate: content.cleanEnding=false fails clean_ending (error)', () => {
  const m: Measures = { ...PASSING, content: { ...PASSING.content!, cleanEnding: false } };
  const checks = evaluate(m, EXPECTED_DURATION);
  expect(nameOk(checks, 'clean_ending')).toBe(false);
  expect(severityOf(checks, 'clean_ending')).toBe('error');
});

it('evaluate: content.standalone=false fails standalone as a WARN, not error', () => {
  const m: Measures = { ...PASSING, content: { ...PASSING.content!, standalone: false } };
  const checks = evaluate(m, EXPECTED_DURATION);
  expect(nameOk(checks, 'standalone')).toBe(false);
  expect(severityOf(checks, 'standalone')).toBe('warn');
});

it('evaluate: content checks are omitted entirely when content is null', () => {
  const m: Measures = { ...PASSING, content: null };
  const checks = evaluate(m, EXPECTED_DURATION);
  for (const name of ['standalone', 'clean_ending', 'hook_matches', 'content_issues']) {
    expect(checks.find((c) => c.name === name)).toBeUndefined();
  }
});

it('evaluate: duration mismatch beyond +/-0.25s fails duration (error)', () => {
  const m: Measures = { ...PASSING, probe: { ...PASSING.probe, durationSec: 31.0 } };
  const checks = evaluate(m, EXPECTED_DURATION);
  expect(nameOk(checks, 'duration')).toBe(false);
});

it('evaluate: true_peak above -0.5 fails true_peak (error)', () => {
  const m: Measures = { ...PASSING, loudness: { ...PASSING.loudness, tp: -0.2 } };
  const checks = evaluate(m, EXPECTED_DURATION);
  expect(nameOk(checks, 'true_peak')).toBe(false);
  expect(severityOf(checks, 'true_peak')).toBe('error');
});

it('evaluate: a >=0.5s black interval fails black_frames (error)', () => {
  const m: Measures = { ...PASSING, black: [{ start: 1, end: 1.6 }] };
  const checks = evaluate(m, EXPECTED_DURATION);
  expect(nameOk(checks, 'black_frames')).toBe(false);
  expect(severityOf(checks, 'black_frames')).toBe('error');
});

it('evaluate: a >=2.5s freeze fails frozen_video as a WARN', () => {
  const m: Measures = { ...PASSING, freezes: [{ start: 1, end: 4 }] };
  const checks = evaluate(m, EXPECTED_DURATION);
  expect(nameOk(checks, 'frozen_video')).toBe(false);
  expect(severityOf(checks, 'frozen_video')).toBe('warn');
});

it('evaluate: caption page over 24 chars fails captions_length as a WARN', () => {
  const m: Measures = { ...PASSING, maxCaptionChars: 30 };
  const checks = evaluate(m, EXPECTED_DURATION);
  expect(nameOk(checks, 'captions_length')).toBe(false);
  expect(severityOf(checks, 'captions_length')).toBe('warn');
});

// ---- visionChecks() ----

const KEEP: VisionCritique = {
  framingOk: true,
  captionsReadable: true,
  hookReadable: true,
  overlaysCoverFace: false,
  verdict: 'keep',
  improvements: [],
  reason: 'looks good',
};

it('visionChecks: a keep verdict passes vision_verdict', () => {
  const checks = visionChecks(KEEP);
  expect(checks.find((c) => c.name === 'vision_verdict')?.ok).toBe(true);
});

it('visionChecks: a reject verdict fails vision_verdict with error severity', () => {
  const v: VisionCritique = { ...KEEP, verdict: 'reject', reason: 'unreadable captions' };
  const checks = visionChecks(v);
  const vv = checks.find((c) => c.name === 'vision_verdict');
  expect(vv?.ok).toBe(false);
  expect(vv?.severity).toBe('error');
  expect(vv?.detail).toContain('unreadable captions');
});

it('visionChecks: an improve verdict also fails vision_verdict (not just reject)', () => {
  const v: VisionCritique = { ...KEEP, verdict: 'improve', improvements: ['fit_layout'] };
  const checks = visionChecks(v);
  expect(checks.find((c) => c.name === 'vision_verdict')?.ok).toBe(false);
});

it('visionChecks: framingOk=false fails vision_framing as a WARN (soft signal)', () => {
  const v: VisionCritique = { ...KEEP, framingOk: false };
  const checks = visionChecks(v);
  const vf = checks.find((c) => c.name === 'vision_framing');
  expect(vf?.ok).toBe(false);
  expect(vf?.severity).toBe('warn');
});

it('visionChecks: captionsReadable=false fails vision_captions as a WARN', () => {
  const v: VisionCritique = { ...KEEP, captionsReadable: false };
  const checks = visionChecks(v);
  const vc = checks.find((c) => c.name === 'vision_captions');
  expect(vc?.ok).toBe(false);
  expect(vc?.severity).toBe('warn');
});

// ---- planFix() : vision-verdict -> fix mapping ----

const CTX: FixCtx = { hookIndex: 0, hookCount: 2, allNonFitSegments: [0, 1, 2] };
const OK_MEASURES = PASSING;

it('planFix: loudness failure plans a remaster, ahead of any vision fix', () => {
  const checks = evaluate({ ...PASSING, loudness: { i: -20, tp: -1 } }, EXPECTED_DURATION);
  const v: VisionCritique = { ...KEEP, verdict: 'reject', improvements: ['fit_layout'] };
  const plan = planFix(checks, PASSING, v, CTX);
  expect(plan).toEqual({ kind: 'remaster', reason: 'loudness/true_peak out of spec' });
});

it('planFix: framing failure with failing segments plans fit_segments for exactly those segments', () => {
  const measures: Measures = {
    ...PASSING,
    faceChecks: [
      { segment: 0, ok: false },
      { segment: 1, ok: true },
      { segment: 2, ok: false },
    ],
  };
  const checks = evaluate(measures, EXPECTED_DURATION);
  const plan = planFix(checks, measures, null, CTX);
  expect(plan).toEqual({ kind: 'fit_segments', segments: [0, 2], reason: 'framing failed' });
});

it('planFix: hook_matches failure plans next_hook only when a next hook exists', () => {
  const checks = evaluate({ ...PASSING, content: { ...PASSING.content!, hookMatches: false } }, EXPECTED_DURATION);
  expect(planFix(checks, PASSING, null, CTX)).toEqual({ kind: 'next_hook', reason: 'hook_matches failed' });
  const lastHookCtx: FixCtx = { ...CTX, hookIndex: 1, hookCount: 2 };
  // no next hook available -> falls through to null (no other failures, no vision)
  expect(planFix(checks, PASSING, null, lastHookCtx)).toBeNull();
});

it('planFix: dead_air failure plans loosen_pauses', () => {
  const checks = evaluate({ ...PASSING, silences: [{ start: 1, end: 3 }] }, EXPECTED_DURATION);
  expect(planFix(checks, PASSING, null, CTX)).toEqual({ kind: 'loosen_pauses', reason: 'dead_air failed' });
});

it('planFix: all rule checks pass + vision reject with fit_layout uses faceChecks failures when present', () => {
  const measures: Measures = {
    ...PASSING,
    faceChecks: [
      { segment: 0, ok: true },
      { segment: 1, ok: true },
      { segment: 2, ok: false },
    ],
  };
  const checks = evaluate(measures, EXPECTED_DURATION); // framing still passes (2/3 = 66% >= 60%)
  const v: VisionCritique = { ...KEEP, verdict: 'improve', improvements: ['fit_layout'] };
  const plan = planFix(checks, measures, v, CTX);
  expect(plan).toEqual({ kind: 'fit_segments', segments: [2], reason: 'vision: fit_layout' });
});

it('planFix: vision fit_layout falls back to allNonFitSegments when no faceChecks are failing', () => {
  const checks = evaluate(OK_MEASURES, EXPECTED_DURATION);
  const v: VisionCritique = { ...KEEP, verdict: 'improve', improvements: ['fit_layout'] };
  const plan = planFix(checks, OK_MEASURES, v, CTX);
  expect(plan).toEqual({ kind: 'fit_segments', segments: CTX.allNonFitSegments, reason: 'vision: fit_layout' });
});

it('planFix: vision next_hook is skipped (falls through) when there is no next hook, tries the next improvement', () => {
  const checks = evaluate(OK_MEASURES, EXPECTED_DURATION);
  const v: VisionCritique = { ...KEEP, verdict: 'improve', improvements: ['next_hook', 'extend_end'] };
  const noNextHookCtx: FixCtx = { ...CTX, hookIndex: 1, hookCount: 2 };
  const plan = planFix(checks, OK_MEASURES, v, noNextHookCtx);
  expect(plan).toEqual({ kind: 'extend_end', reason: 'vision: extend_end' });
});

it('planFix: vision trim_start maps directly to a trim_start plan', () => {
  const checks = evaluate(OK_MEASURES, EXPECTED_DURATION);
  const v: VisionCritique = { ...KEEP, verdict: 'reject', improvements: ['trim_start'] };
  expect(planFix(checks, OK_MEASURES, v, CTX)).toEqual({ kind: 'trim_start', reason: 'vision: trim_start' });
});

it('planFix: nothing to fix (all pass, verdict keep) returns null', () => {
  const checks = evaluate(OK_MEASURES, EXPECTED_DURATION);
  expect(planFix(checks, OK_MEASURES, KEEP, CTX)).toBeNull();
});

it('planFix: reject verdict with an empty improvements list returns null (unfixable)', () => {
  const checks = evaluate(OK_MEASURES, EXPECTED_DURATION);
  const v: VisionCritique = { ...KEEP, verdict: 'reject', improvements: [], reason: 'fundamentally broken' };
  expect(planFix(checks, OK_MEASURES, v, CTX)).toBeNull();
});

// ---- nextSentenceEnd / nextSentenceStart ----

const SENTENCES: Sentence[] = [
  { id: 0, text: 'a', start: 0, end: 2, w0: 0, w1: 0 },
  { id: 1, text: 'b', start: 2, end: 5, w0: 1, w1: 1 },
  { id: 2, text: 'c', start: 5, end: 9, w0: 2, w1: 2 },
];

it('nextSentenceEnd: mid-sentence cutoff extends to that sentence\'s own end', () => {
  expect(nextSentenceEnd(SENTENCES, 3)).toBe(5);
});
it('nextSentenceEnd: a cutoff exactly on a boundary extends to the NEXT sentence\'s end', () => {
  expect(nextSentenceEnd(SENTENCES, 5)).toBe(9);
});
it('nextSentenceEnd: no later sentence returns null', () => {
  expect(nextSentenceEnd(SENTENCES, 9)).toBeNull();
});
it('nextSentenceStart: returns the start of the first sentence beginning after the given point', () => {
  expect(nextSentenceStart(SENTENCES, 0)).toBe(2);
  expect(nextSentenceStart(SENTENCES, 4)).toBe(5);
  expect(nextSentenceStart(SENTENCES, 9)).toBeNull();
});

// ---- parseLavfiIntervals() ----

it('parseLavfiIntervals: parses silencedetect two-line start/end format', () => {
  const stderr =
    '[Parsed_silencedetect_0 @ 0x1] silence_start: 0\n' +
    '[Parsed_silencedetect_0 @ 0x1] silence_end: 4 | silence_duration: 4\n';
  expect(parseLavfiIntervals(stderr, 'silence')).toEqual([{ start: 0, end: 4 }]);
});

it('parseLavfiIntervals: parses blackdetect single-line start/end/duration format', () => {
  const stderr = '[Parsed_blackdetect_0 @ 0x1] black_start:0 black_end:3.966667 black_duration:3.966667\n';
  expect(parseLavfiIntervals(stderr, 'black')).toEqual([{ start: 0, end: 3.966667 }]);
});

it('parseLavfiIntervals: parses freezedetect lavfi-prefixed, out-of-order start/duration/end format', () => {
  const stderr =
    '[Parsed_freezedetect_0 @ 0x1] lavfi.freezedetect.freeze_start: 0\n' +
    '[Parsed_freezedetect_0 @ 0x1] lavfi.freezedetect.freeze_duration: 3.5\n' +
    '[Parsed_freezedetect_0 @ 0x1] lavfi.freezedetect.freeze_end: 3.5\n';
  expect(parseLavfiIntervals(stderr, 'freeze')).toEqual([{ start: 0, end: 3.5 }]);
});

it('parseLavfiIntervals: an unterminated interval (started but never ended before EOF) is dropped', () => {
  const stderr = '[Parsed_freezedetect_0 @ 0x1] lavfi.freezedetect.freeze_start: 0\n';
  expect(parseLavfiIntervals(stderr, 'freeze')).toEqual([]);
});

it('parseLavfiIntervals: no matches returns an empty array', () => {
  expect(parseLavfiIntervals('nothing interesting here', 'black')).toEqual([]);
});

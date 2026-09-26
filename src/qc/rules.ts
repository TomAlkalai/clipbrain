import type { QcCheck, Sentence, Silence } from '../types.js';

export type Measures = {
  probe: { width: number; height: number; vcodec: string; pixFmt: string; fps: number; acodec: string | null; durationSec: number };
  loudness: { i: number; tp: number };
  silences: Silence[];
  black: { start: number; end: number }[];
  freezes: { start: number; end: number }[];
  faceChecks: { segment: number; ok: boolean }[];
  content: { standalone: boolean; cleanEnding: boolean; hookMatches: boolean; issues: string[] } | null;
  maxCaptionChars: number;
};

function check(name: string, ok: boolean, detail: string, severity: 'error' | 'warn'): QcCheck {
  return { name, ok, detail, severity };
}

/**
 * Pure decision rules over a clip's measured properties. Each check's rule/severity is exactly
 * as specified in task-13-brief.md. `content` checks are only emitted when `m.content` is
 * present (the LLM content-QA call succeeded); `framing` is only emitted when there is at least
 * one face-layout segment to judge.
 */
export function evaluate(m: Measures, expectedDurationSec: number): QcCheck[] {
  const out: QcCheck[] = [];

  out.push(
    check(
      'resolution',
      m.probe.width === 1080 && m.probe.height === 1920,
      `${m.probe.width}x${m.probe.height} (want 1080x1920)`,
      'error',
    ),
  );

  out.push(
    check(
      'codec',
      m.probe.vcodec === 'h264' && m.probe.pixFmt === 'yuv420p',
      `vcodec=${m.probe.vcodec} pixFmt=${m.probe.pixFmt} (want h264/yuv420p)`,
      'error',
    ),
  );

  out.push(check('fps', Math.abs(m.probe.fps - 30) < 0.01, `${m.probe.fps.toFixed(3)}fps (want 30)`, 'error'));

  out.push(check('audio', m.probe.acodec === 'aac', `acodec=${m.probe.acodec ?? 'none'} (want aac)`, 'error'));

  out.push(
    check(
      'duration',
      Math.abs(m.probe.durationSec - expectedDurationSec) <= 0.25,
      `${m.probe.durationSec.toFixed(2)}s (want ${expectedDurationSec.toFixed(2)}s +/-0.25)`,
      'error',
    ),
  );

  out.push(
    check(
      'loudness',
      m.loudness.i >= -15.5 && m.loudness.i <= -12.5,
      `${m.loudness.i.toFixed(1)} LUFS (want -15.5..-12.5)`,
      'error',
    ),
  );

  out.push(check('true_peak', m.loudness.tp <= -0.5, `${m.loudness.tp.toFixed(1)} dBTP (want <= -0.5)`, 'error'));

  const longSilence = m.silences.find((s) => s.end - s.start >= 1.2);
  out.push(
    check(
      'dead_air',
      !longSilence,
      longSilence ? `silence ${longSilence.start.toFixed(2)}-${longSilence.end.toFixed(2)}s` : 'no silence >= 1.2s',
      'error',
    ),
  );

  const longBlack = m.black.find((b) => b.end - b.start >= 0.5);
  out.push(
    check(
      'black_frames',
      !longBlack,
      longBlack ? `black ${longBlack.start.toFixed(2)}-${longBlack.end.toFixed(2)}s` : 'no black >= 0.5s',
      'error',
    ),
  );

  const longFreeze = m.freezes.find((f) => f.end - f.start >= 2.5);
  out.push(
    check(
      'frozen_video',
      !longFreeze,
      longFreeze ? `freeze ${longFreeze.start.toFixed(2)}-${longFreeze.end.toFixed(2)}s` : 'no freeze >= 2.5s',
      'warn',
    ),
  );

  if (m.faceChecks.length > 0) {
    const okCount = m.faceChecks.filter((f) => f.ok).length;
    const ratio = okCount / m.faceChecks.length;
    out.push(
      check(
        'framing',
        ratio >= 0.6,
        `${okCount}/${m.faceChecks.length} face segment(s) framed ok (${(ratio * 100).toFixed(0)}%, want >=60%)`,
        'error',
      ),
    );
  }

  out.push(
    check(
      'captions_length',
      m.maxCaptionChars <= 24,
      `max caption page ${m.maxCaptionChars} chars (want <=24)`,
      'warn',
    ),
  );

  if (m.content) {
    out.push(
      check(
        'standalone',
        m.content.standalone,
        m.content.standalone ? 'clip stands alone' : 'clip may not stand alone without context',
        'warn',
      ),
    );
    out.push(
      check(
        'clean_ending',
        m.content.cleanEnding,
        m.content.cleanEnding ? 'ends cleanly' : 'ending is cut off / incomplete',
        'error',
      ),
    );
    out.push(
      check(
        'hook_matches',
        m.content.hookMatches,
        m.content.hookMatches ? 'delivers on the hook' : 'content does not deliver on the hook',
        'error',
      ),
    );
    out.push(
      check(
        'content_issues',
        m.content.issues.length === 0,
        m.content.issues.length === 0 ? 'no content issues' : m.content.issues.join('; '),
        'warn',
      ),
    );
  }

  return out;
}

// ---- Vision critique (EXTENSION) ----

export type VisionImprovement = 'fit_layout' | 'next_hook' | 'extend_end' | 'trim_start';
export type VisionVerdict = 'keep' | 'improve' | 'reject';

export type VisionCritique = {
  framingOk: boolean;
  captionsReadable: boolean;
  hookReadable: boolean;
  overlaysCoverFace: boolean;
  verdict: VisionVerdict;
  improvements: VisionImprovement[];
  reason: string;
};

/**
 * Turns a vision critic's structured verdict into QcChecks. `vision_verdict` is the decisive,
 * error-severity check — any verdict other than 'keep' fails it, so an unresolved 'improve' (not
 * just an outright 'reject') still fails QC once the auto-fix budget is exhausted (see qc.ts).
 * `vision_framing`/`vision_captions` are softer, warn-severity corroborating signals — the
 * rule-based `framing`/`captions_length` checks already gate on the objective versions of these.
 */
export function visionChecks(v: VisionCritique): QcCheck[] {
  return [
    check('vision_framing', v.framingOk, v.framingOk ? 'vision: framing looks fine' : 'vision: framing flagged', 'warn'),
    check(
      'vision_captions',
      v.captionsReadable,
      v.captionsReadable ? 'vision: captions readable' : 'vision: captions flagged as unreadable',
      'warn',
    ),
    check('vision_verdict', v.verdict === 'keep', `vision verdict=${v.verdict}: ${v.reason}`, 'error'),
  ];
}

// ---- Auto-fix mapping (pure decision; qc.ts performs the actual I/O) ----

export type FixPlan =
  | { kind: 'remaster'; reason: string }
  | { kind: 'fit_segments'; segments: number[]; reason: string }
  | { kind: 'next_hook'; reason: string }
  | { kind: 'extend_end'; reason: string }
  | { kind: 'trim_start'; reason: string }
  | { kind: 'loosen_pauses'; reason: string };

export type FixCtx = {
  hookIndex: number;
  hookCount: number;
  /** Indices of segments whose layout isn't already 'fit' — the fallback target set for a
   * vision `fit_layout` improvement when the rule-based face check has no failing segments of
   * its own to point at (e.g. framing passed the 60% bar but the vision critic still didn't
   * like it). */
  allNonFitSegments: number[];
};

/**
 * Decides the single next auto-fix action for a QC round, given the round's checks/measures and
 * (if run) the vision critique. Rule-based fixes (loudness/true_peak, clean_ending, hook_matches,
 * framing, dead_air) take priority, in the order task-13-brief.md lists them, over vision-driven
 * ones — a vision fix is only considered once none of the rule-based failures have an applicable
 * fix. Returns null when nothing more can be done (QC then finalizes as-is). Pure.
 */
export function planFix(checks: QcCheck[], measures: Measures, vision: VisionCritique | null, ctx: FixCtx): FixPlan | null {
  const failing = (name: string) => checks.some((c) => c.name === name && !c.ok);

  if (failing('loudness') || failing('true_peak')) {
    return { kind: 'remaster', reason: 'loudness/true_peak out of spec' };
  }
  if (failing('clean_ending')) {
    return { kind: 'extend_end', reason: 'clean_ending failed' };
  }
  if (failing('hook_matches') && ctx.hookIndex + 1 < ctx.hookCount) {
    return { kind: 'next_hook', reason: 'hook_matches failed' };
  }
  if (failing('framing')) {
    const segments = measures.faceChecks.filter((f) => !f.ok).map((f) => f.segment);
    if (segments.length > 0) return { kind: 'fit_segments', segments, reason: 'framing failed' };
  }
  if (failing('dead_air')) {
    return { kind: 'loosen_pauses', reason: 'dead_air failed' };
  }

  if (vision && vision.verdict !== 'keep') {
    for (const improvement of vision.improvements) {
      if (improvement === 'fit_layout') {
        const failingFace = measures.faceChecks.filter((f) => !f.ok).map((f) => f.segment);
        const segments = failingFace.length > 0 ? failingFace : ctx.allNonFitSegments;
        if (segments.length > 0) return { kind: 'fit_segments', segments, reason: 'vision: fit_layout' };
      } else if (improvement === 'next_hook') {
        if (ctx.hookIndex + 1 < ctx.hookCount) return { kind: 'next_hook', reason: 'vision: next_hook' };
      } else if (improvement === 'extend_end') {
        return { kind: 'extend_end', reason: 'vision: extend_end' };
      } else if (improvement === 'trim_start') {
        return { kind: 'trim_start', reason: 'vision: trim_start' };
      }
    }
  }

  return null;
}

// ---- Sentence-boundary helpers for extend_end / trim_start fixes ----

/** The end of the first sentence whose own end is strictly after `end` — i.e. either the end of
 * the sentence `end` currently cuts off mid-way through, or (if `end` already lands exactly on a
 * sentence boundary) the end of the very next sentence. Pure. */
export function nextSentenceEnd(sentences: Sentence[], end: number): number | null {
  const s = sentences.find((s) => s.end > end);
  return s ? s.end : null;
}

/** The start of the first sentence whose own start is strictly after `start`. Pure. */
export function nextSentenceStart(sentences: Sentence[], start: number): number | null {
  const s = sentences.find((s) => s.start > start);
  return s ? s.start : null;
}

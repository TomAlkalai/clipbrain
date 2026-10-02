import { env } from '../config.js';

// A render must never wait forever (HANDOFF open item #2: `produce` sat for 5 days on
// clip_4v1cw97c with headless Chrome open after Remotion lost its connection). This bounds the
// Chrome phase of a render: it fails when no progress arrives for `stallMs`, or when `hardMs` has
// passed regardless of progress; runs a cleanup (cancel Remotion, kill Chrome) with its own bound;
// and never waits on the hung work itself.

export class RenderTimeoutError extends Error {
  constructor(
    readonly kind: 'stall' | 'hard',
    message: string,
  ) {
    super(message);
    this.name = 'RenderTimeoutError';
  }
}

export type WatchdogOpts = {
  /** Fail when no `progress()` call arrives for this long. */
  stallMs: number;
  /** Fail when the whole task takes longer than this, even while progressing. */
  hardMs: number;
  /** Releases what the hung task holds (cancel Remotion, close Chrome). Bounded by cleanupTimeoutMs. */
  cleanup: () => Promise<void>;
  cleanupTimeoutMs?: number;
  /** Last known progress, quoted in the error (e.g. "frame 1200/3600"). */
  describe?: () => string;
};

const DEFAULT_CLEANUP_TIMEOUT_MS = 30_000;
const minutes = (ms: number) => (ms / 60_000).toFixed(1);

/**
 * Runs `task`, failing it with a RenderTimeoutError on a stall or the hard cap. After a timeout
 * the task is abandoned (its eventual outcome is ignored, never an unhandled rejection), cleanup
 * runs, and only then does the returned promise reject — so the caller continues with Chrome
 * already gone. A task error before any timeout is passed through unchanged.
 */
export async function withRenderWatchdog<T>(task: (ctx: { progress: () => void }) => Promise<T>, o: WatchdogOpts): Promise<T> {
  let stallTimer: NodeJS.Timeout | undefined;
  let hardTimer: NodeJS.Timeout | undefined;
  let finished = false;
  let tripped = false;
  let rejectTimeout!: (e: RenderTimeoutError) => void;
  const timedOut = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });

  const clearTimers = () => {
    clearTimeout(stallTimer);
    clearTimeout(hardTimer);
  };

  const trip = (kind: 'stall' | 'hard') => {
    if (finished || tripped) return;
    tripped = true;
    clearTimers();
    const what = kind === 'stall' ? `no render progress for ${minutes(o.stallMs)} min` : `exceeded the ${minutes(o.hardMs)} min render limit`;
    const last = o.describe?.();
    const base = `render timed out: ${what}${last ? ` (last progress: ${last})` : ''} — render aborted and its Chrome closed`;
    let bound: NodeJS.Timeout | undefined;
    const cleanupTimeoutMs = o.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
    const cleanup = Promise.resolve()
      .then(() => o.cleanup())
      .then(
        () => null,
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
    const deadline = new Promise<string>((resolve) => {
      bound = setTimeout(() => resolve(`did not finish within ${minutes(cleanupTimeoutMs)} min`), cleanupTimeoutMs);
    });
    void Promise.race([cleanup, deadline]).then((cleanupErr) => {
      clearTimeout(bound);
      rejectTimeout(new RenderTimeoutError(kind, cleanupErr ? `${base}; cleanup failed: ${cleanupErr}` : base));
    });
  };

  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => trip('stall'), o.stallMs);
  };
  const progress = () => {
    if (!finished && !tripped) armStall();
  };

  armStall();
  hardTimer = setTimeout(() => trip('hard'), o.hardMs);

  const work = Promise.resolve().then(() => task({ progress }));
  // Once tripped, the outcome is the timeout, whatever the abandoned task does later.
  const guarded = work.then(
    (v) => (tripped ? timedOut : v),
    (err) => {
      if (tripped) return timedOut;
      throw err;
    },
  );
  try {
    return await Promise.race([guarded, timedOut]);
  } finally {
    finished = true;
    clearTimers();
  }
}

export type RenderTimeouts = { stallMs: number; hardMs: number; warnings: string[] };

const DEFAULT_STALL_MIN = 5;
const DEFAULT_TIMEOUT_MIN = 60;

function minutesFromEnv(raw: string | undefined, name: string, fallback: number, warnings: string[]): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  warnings.push(`${name}="${raw}" is not a positive number of minutes — using ${fallback}`);
  return fallback;
}

/**
 * Pure: render timeouts from env, in minutes. CB_RENDER_STALL_MIN (default 5) is how long a render
 * may go without any Remotion progress; CB_RENDER_TIMEOUT_MIN (default 60) caps a whole render.
 * Normal renders run ≈3–6.5× the clip's length (≈10–17 min for a 2.5-min clip) and report
 * progress every frame, so neither default trips on a healthy render.
 */
export function parseRenderTimeouts(e: { CB_RENDER_STALL_MIN?: string; CB_RENDER_TIMEOUT_MIN?: string }): RenderTimeouts {
  const warnings: string[] = [];
  const stallMin = minutesFromEnv(e.CB_RENDER_STALL_MIN, 'CB_RENDER_STALL_MIN', DEFAULT_STALL_MIN, warnings);
  const hardMin = minutesFromEnv(e.CB_RENDER_TIMEOUT_MIN, 'CB_RENDER_TIMEOUT_MIN', DEFAULT_TIMEOUT_MIN, warnings);
  return { stallMs: Math.min(stallMin, hardMin) * 60_000, hardMs: hardMin * 60_000, warnings };
}

export function renderTimeouts(): RenderTimeouts {
  return parseRenderTimeouts({ CB_RENDER_STALL_MIN: env('CB_RENDER_STALL_MIN'), CB_RENDER_TIMEOUT_MIN: env('CB_RENDER_TIMEOUT_MIN') });
}

import { isIgnorableKillEperm } from './proc.js';
import { log } from '../log.js';

export type CrashEvent = 'uncaughtException' | 'unhandledRejection';
/** Injected in tests; production uses the real process, logger, stdio and exit. */
export type CrashGuardDeps = {
  on: (event: CrashEvent, handler: (err: unknown) => void) => void;
  log: (...a: unknown[]) => void;
  flush: () => Promise<void>;
  exit: (code: number) => void;
};

const FLUSH_TIMEOUT_MS = 2000;
// Errors raised while already exiting are still reported, up to this many — a broken stderr
// pipe (EPIPE) would otherwise turn every report into another uncaught error.
const MAX_FOLLOW_UP_LOGS = 3;

/**
 * Resolves once each stream has written out everything queued on it so far (a zero-length write
 * calls back after all earlier chunks), or after `timeoutMs` — a stuck pipe must not keep a
 * crashing process alive.
 */
export function flushStreams(streams: NodeJS.WritableStream[], timeoutMs: number): Promise<void> {
  const drained = streams.map(
    (s) =>
      new Promise<void>((resolve) => {
        try {
          s.write('', () => resolve());
        } catch {
          resolve();
        }
      }),
  );
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  return Promise.race([Promise.all(drained).then(() => undefined), timeout]).finally(() => clearTimeout(timer));
}

function defaultDeps(): CrashGuardDeps {
  return {
    on: (event, handler) => {
      if (event === 'uncaughtException') process.on('uncaughtException', handler);
      else process.on('unhandledRejection', handler);
    },
    log,
    flush: () => flushStreams([process.stdout, process.stderr], FLUSH_TIMEOUT_MS),
    exit: (code) => {
      process.exitCode = code;
      process.exit(code);
    },
  };
}

/**
 * Bug 3 fix (important): a renderer failure used to kill the whole CLI. @remotion/renderer's
 * browser/compositor teardown can emit an 'error' event (code EPERM, syscall 'kill') on a
 * Windows ChildProcess with no 'error' listener. Node re-emits an unlistened 'error' event as an
 * uncaughtException, which crashed the process before the per-clip try/catch in
 * produce/requalify ever ran, abandoning every remaining clip in a batch. The uncaughtException
 * handler swallows ONLY that exact shape (isIgnorableKillEperm) with a one-line warning.
 *
 * Everything else is fatal: logged, then stdout/stderr are flushed, then exit 1. Exiting right
 * after the log line could drop it (and earlier output) when stdio is a pipe, which is
 * asynchronous on Windows.
 */
export function installCrashGuards(deps: CrashGuardDeps = defaultDeps()): void {
  let exiting = false;
  let followUps = 0;
  const fatal = (err: unknown): void => {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    if (exiting) {
      if (followUps++ < MAX_FOLLOW_UP_LOGS) deps.log('error (while exiting):', msg);
      return;
    }
    exiting = true;
    deps.log('error:', msg);
    deps.flush().then(
      () => deps.exit(1),
      () => deps.exit(1),
    );
  };

  deps.on('uncaughtException', (err) => {
    if (isIgnorableKillEperm(err)) {
      deps.log('warning: ignoring EPERM from a child-process kill during renderer teardown (Bug 3 mitigation)');
      return;
    }
    fatal(err);
  });
  // Fatal for every reason, kill EPERM included: that error only ever arrives as an unlistened
  // 'error' event (uncaughtException above), while a rejected promise nobody handled is a real
  // bug. Having this listener also stops Node from re-raising unhandled rejections as
  // uncaughtException, where the EPERM ignore would otherwise apply to them.
  deps.on('unhandledRejection', fatal);
}

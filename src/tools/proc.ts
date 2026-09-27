import { spawn, type ChildProcess } from 'node:child_process';

export type RunOpts = {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  shell?: boolean;
};

export type RunResult = { code: number; stdout: string; stderr: string };

export function spawnStream(cmd: string, args: string[], opts: RunOpts = {}): ChildProcess {
  return spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    shell: opts.shell,
    windowsHide: true,
  });
}

export function run(cmd: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      shell: opts.shell,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });

    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error(`timeout after ${opts.timeoutMs}ms: ${cmd}`));
      }, opts.timeoutMs);
    }

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr });
    });

    child.stdin?.end(opts.input ?? '');
  });
}

export async function runOk(cmd: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    const tail = r.stderr.slice(-2000);
    throw new Error(`${cmd} exited with code ${r.code}: ${tail}`);
  }
  return r;
}

/**
 * True for the specific error shape @remotion/renderer's browser/compositor teardown emits on
 * Windows: `error.code === 'EPERM'`, `error.syscall === 'kill'` — a ChildProcess with no 'error'
 * listener attached failing to kill an already-exited (or otherwise inaccessible) process during
 * cleanup. Node re-emits an unlistened 'error' event as an uncaughtException, which (Bug 3) used
 * to crash the whole CLI process even when the render itself had already succeeded, or had
 * already failed for a separate, already-handled reason — abandoning every remaining clip in a
 * batch. src/cli.ts's global uncaughtException/unhandledRejection handlers use this predicate to
 * swallow ONLY this exact shape; anything else must still crash the process. Pure.
 */
export function isIgnorableKillEperm(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; syscall?: unknown };
  return e.code === 'EPERM' && e.syscall === 'kill';
}

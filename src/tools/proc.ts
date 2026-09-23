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

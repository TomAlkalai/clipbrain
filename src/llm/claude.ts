import fs from 'node:fs';
import path from 'node:path';
import { run, type RunResult } from '../tools/proc.js';
import { DATA } from '../config.js';
import type { Backend } from './llm.js';

export type PickedClaude = { cmd: string; viaCmdShell: boolean };

// Pure: pick which line of `where claude` output to spawn, and whether it's a shim that
// needs special handling. npm-installed Claude Code on Windows can leave `claude.cmd` (a
// generated shim) on PATH ahead of, or instead of, a real `claude.exe` — `where` lists
// every match, in PATH order, one per line.
export function pickClaudeExecutable(whereOutput: string): PickedClaude | null {
  const lines = whereOutput
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  const exe = lines.find((l) => /\.exe$/i.test(l));
  if (exe) return { cmd: exe, viaCmdShell: false };
  const shim = lines.find((l) => /\.(cmd|bat)$/i.test(l));
  if (shim) return { cmd: shim, viaCmdShell: true };
  // Unrecognized extension (e.g. an extensionless entry) — try it directly, same as an .exe.
  return { cmd: lines[0], viaCmdShell: false };
}

// Pure: extracts the JS entry point an npm-generated `.cmd`/`.bat` shim wraps. npm's
// `cmd-shim` format ends with a line like
//   ... "%dp0%\node.exe" "%dp0%\node_modules\@anthropic-ai\claude-code\cli.js" %*
// so the last `"...*.js"` in the file, with `%dp0%` resolved against the shim's own
// directory, is the script to run. Spawning that script directly with `node` (plain
// array args, no shell) sidesteps the shim entirely — which matters because forwarding
// through the shim's `%*` does not reliably survive: measured directly, a `cmd.exe /d /s
// /c "..."` invocation of the shim mangles an empty `--tools ""` into a literal `""`
// two-character token and splits a quoted, space-containing `--system-prompt` value on
// every space, because the batch file's `%*` substitution and the CRT's argv parsing of
// the resulting line don't compose the way naive re-quoting assumes.
export function extractShimScript(shimContents: string, shimDir: string): string | null {
  const matches = [...shimContents.matchAll(/"([^"]+\.m?js)"/gi)].map((m) => m[1]);
  if (matches.length === 0) return null;
  const raw = matches[matches.length - 1].replace(/%dp0%/gi, shimDir);
  return path.resolve(raw);
}

type Resolved = { kind: 'exe'; cmd: string } | { kind: 'script'; script: string };

// Resolved once per process and cached: `undefined` = not yet attempted, `null` = attempted
// and nothing usable was found (subsequent calls keep retrying the bare `claude` name, in
// case PATH changes at runtime).
let resolved: Resolved | null | undefined;
let resolving: Promise<Resolved | null> | undefined;

async function resolveClaudeExecutable(): Promise<Resolved | null> {
  if (resolved !== undefined) return resolved;
  if (!resolving) {
    resolving = (async () => {
      const r = await run('where', ['claude']);
      if (r.code !== 0) return (resolved = null);
      const picked = pickClaudeExecutable(r.stdout);
      if (!picked) return (resolved = null);
      if (!picked.viaCmdShell) return (resolved = { kind: 'exe', cmd: picked.cmd });
      let contents: string;
      try {
        contents = fs.readFileSync(picked.cmd, 'utf8');
      } catch {
        return (resolved = null);
      }
      const script = extractShimScript(contents, path.dirname(picked.cmd));
      return (resolved = script ? { kind: 'script', script } : null);
    })();
  }
  return resolving;
}

async function runResolved(target: Resolved, args: string[], opts: { cwd: string; input: string; timeoutMs: number }): Promise<RunResult> {
  if (target.kind === 'exe') return run(target.cmd, args, opts);
  return run(process.execPath, [target.script, ...args], opts);
}

// Spawns `claude`, falling back to a `where`-resolved path if the bare command name isn't
// directly executable (ENOENT) — which happens when only an npm-installed `claude.cmd`
// shim is on PATH (Windows refuses to spawn `.cmd`/`.bat` files without a shell).
async function spawnClaude(args: string[], opts: { cwd: string; input: string; timeoutMs: number }): Promise<RunResult> {
  if (resolved !== undefined && resolved !== null) {
    return runResolved(resolved, args, opts);
  }
  try {
    return await run('claude', args, opts);
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
    const target = await resolveClaudeExecutable();
    if (!target) throw err;
    return runResolved(target, args, opts);
  }
}

export const claudeBackend: Backend = async ({ model, system, prompt, schema }) => {
  const cwd = path.join(DATA, '.llm-sandbox');
  fs.mkdirSync(cwd, { recursive: true });
  const args = [
    '-p', '--model', model,
    '--output-format', 'json',
    '--json-schema', JSON.stringify(schema),
    '--tools', '',
    '--safe-mode',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--system-prompt', system,
  ];
  const r = await spawnClaude(args, { cwd, input: prompt, timeoutMs: 15 * 60_000 });
  let j: any;
  try {
    j = JSON.parse(r.stdout);
  } catch {
    throw new Error(`claude returned non-JSON (code ${r.code}): ${r.stdout.slice(0, 500)} ${r.stderr.slice(-500)}`);
  }
  if (j.is_error || j.subtype !== 'success') {
    throw new Error(`claude error: ${j.subtype} ${String(j.result).slice(0, 500)}`);
  }
  const output = j.structured_output ?? JSON.parse(j.result);
  return { output, costUsd: Number(j.total_cost_usd ?? 0) };
};

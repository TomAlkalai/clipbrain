import fs from 'node:fs';
import path from 'node:path';
import { run } from '../tools/proc.js';
import { DATA } from '../config.js';
import type { Backend } from './llm.js';

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
  const r = await run('claude', args, { cwd, input: prompt, timeoutMs: 15 * 60_000 });
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

import { it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
process.env.CB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-'));
const { llmJson, setBackend, ledgerSummary } = await import('../src/llm/llm.js');
const { pickClaudeExecutable, extractShimScript } = await import('../src/llm/claude.js');
it('maps tier to model, caches identical requests, logs ledger', async () => {
  let calls = 0;
  setBackend(async (r) => { calls++; return { output: { echo: r.model }, costUsd: 0.01 }; });
  const req = { tier: 'fast' as const, purpose: 't', system: 's', prompt: 'p', schema: { type: 'object' } };
  expect(await llmJson(req)).toEqual({ echo: 'haiku' });
  expect(await llmJson(req)).toEqual({ echo: 'haiku' });
  expect(calls).toBe(1);
  const s = ledgerSummary();
  expect(s.calls).toBe(2); expect(s.cached).toBe(1); expect(s.costUsd).toBeCloseTo(0.01);
});
it('retries once when the backend throws', async () => {
  let n = 0;
  setBackend(async () => { if (n++ === 0) throw new Error('flaky'); return { output: { ok: true }, costUsd: 0 }; });
  expect(await llmJson({ tier: 'balanced', purpose: 't2', system: 's', prompt: 'x', schema: {} })).toEqual({ ok: true });
});

it('pickClaudeExecutable prefers a real .exe over a .cmd shim, in `where` output order', () => {
  expect(pickClaudeExecutable('C:\\Users\\tomal\\.local\\bin\\claude.exe\r\n')).toEqual({ cmd: 'C:\\Users\\tomal\\.local\\bin\\claude.exe', viaCmdShell: false });
  expect(pickClaudeExecutable('C:\\npm\\claude.cmd\r\nC:\\Users\\tomal\\.local\\bin\\claude.exe\r\n')).toEqual({ cmd: 'C:\\Users\\tomal\\.local\\bin\\claude.exe', viaCmdShell: false });
});
it('pickClaudeExecutable falls back to a .cmd/.bat shim, flagged for special handling', () => {
  expect(pickClaudeExecutable('C:\\npm\\claude.cmd\r\n')).toEqual({ cmd: 'C:\\npm\\claude.cmd', viaCmdShell: true });
  expect(pickClaudeExecutable('C:\\npm\\claude.bat\r\n')).toEqual({ cmd: 'C:\\npm\\claude.bat', viaCmdShell: true });
});
it('pickClaudeExecutable returns null on empty `where` output', () => {
  expect(pickClaudeExecutable('')).toBeNull();
  expect(pickClaudeExecutable('\r\n\r\n')).toBeNull();
});

const NPM_CMD_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET "dp0=%~dp0"',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  ')',
  '',
  'endLocal & "%_prog%" "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
].join('\n');

it('extractShimScript resolves the wrapped entry point from an npm cmd-shim', () => {
  expect(extractShimScript(NPM_CMD_SHIM, 'C:\\npm\\')).toBe(
    path.resolve('C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'),
  );
});
it('extractShimScript returns null when no .js path is found', () => {
  expect(extractShimScript('@echo off\r\necho nothing to see here\r\n', 'C:\\npm\\')).toBeNull();
});

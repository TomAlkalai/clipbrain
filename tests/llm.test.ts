import { it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
process.env.CB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-'));
const { llmJson, setBackend, ledgerSummary } = await import('../src/llm/llm.js');
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

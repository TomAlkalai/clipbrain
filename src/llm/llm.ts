import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA, env } from '../config.js';
import { readJsonOr, writeJson, appendJsonl } from '../store.js';
import type { LedgerEntry } from '../types.js';

export type Tier = 'fast' | 'balanced' | 'strong';
export const MODEL: Record<Tier, string> = { fast: 'haiku', balanced: 'sonnet', strong: 'opus' };

export type Backend = (req: { model: string; system: string; prompt: string; schema: object }) => Promise<{ output: unknown; costUsd: number }>;

let backend: Backend = async () => {
  throw new Error('no LLM backend configured — call setBackend()');
};

export function setBackend(b: Backend): void {
  backend = b;
}

const LEDGER_PATH = () => path.join(DATA, 'ledger.jsonl');
const CACHE_DIR = () => path.join(DATA, '.llm-cache');

function cacheKey(model: string, system: string, prompt: string, schema: object): string {
  const s = JSON.stringify({ model, system, prompt, schema });
  return crypto.createHash('sha256').update(s).digest('hex');
}

function cachePath(key: string): string {
  return path.join(CACHE_DIR(), `${key}.json`);
}

// Simple counting semaphore to cap concurrency.
class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;
  constructor(private size: number) {}
  async acquire(): Promise<() => void> {
    if (this.active < this.size) {
      this.active++;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve(() => this.release());
      });
    });
  }
  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

let semaphore: Semaphore | undefined;
let semaphoreSize: number | undefined;
function getSemaphore(): Semaphore {
  const size = Number(env('CB_LLM_CONCURRENCY', '3'));
  if (!semaphore || semaphoreSize !== size) {
    semaphore = new Semaphore(size);
    semaphoreSize = size;
  }
  return semaphore;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logLedger(entry: LedgerEntry): void {
  appendJsonl(LEDGER_PATH(), entry);
}

export async function llmJson<T>(req: {
  tier: Tier;
  purpose: string;
  system: string;
  prompt: string;
  schema: object;
  noCache?: boolean;
}): Promise<T> {
  const model = MODEL[req.tier];
  const key = cacheKey(model, req.system, req.prompt, req.schema);
  const cp = cachePath(key);

  if (!req.noCache) {
    const cached = readJsonOr<{ output: unknown } | null>(cp, null);
    if (cached !== null) {
      logLedger({ at: new Date().toISOString(), tier: req.tier, model, purpose: req.purpose, costUsd: 0, ms: 0, cached: true });
      return cached.output as T;
    }
  }

  const release = await getSemaphore().acquire();
  const start = Date.now();
  try {
    let result: { output: unknown; costUsd: number };
    try {
      result = await backend({ model, system: req.system, prompt: req.prompt, schema: req.schema });
    } catch {
      await sleep(3000);
      result = await backend({ model, system: req.system, prompt: req.prompt, schema: req.schema });
    }
    const ms = Date.now() - start;
    if (!req.noCache) {
      writeJson(cp, { output: result.output });
    }
    logLedger({ at: new Date().toISOString(), tier: req.tier, model, purpose: req.purpose, costUsd: result.costUsd, ms, cached: false });
    return result.output as T;
  } finally {
    release();
  }
}

export function ledgerSummary(): { calls: number; cached: number; costUsd: number; byPurpose: Record<string, { calls: number; costUsd: number }> } {
  const p = LEDGER_PATH();
  const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const entries: LedgerEntry[] = lines.map((l) => JSON.parse(l));
  const byPurpose: Record<string, { calls: number; costUsd: number }> = {};
  let cached = 0;
  let costUsd = 0;
  for (const e of entries) {
    if (e.cached) cached++;
    costUsd += e.costUsd;
    const bucket = byPurpose[e.purpose] ?? { calls: 0, costUsd: 0 };
    bucket.calls++;
    bucket.costUsd += e.costUsd;
    byPurpose[e.purpose] = bucket;
  }
  return { calls: entries.length, cached, costUsd, byPurpose };
}

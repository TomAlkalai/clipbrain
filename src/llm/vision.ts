import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJsonOr, writeJson } from '../store.js';
import type { LedgerEntry } from '../types.js';
import { MODEL, type Tier, cachePath, logLedger, getSemaphore, sleep } from './llm.js';
import { claudeVisionCall } from './claude.js';

export type VisionBackend = (req: {
  model: string;
  system: string;
  prompt: string;
  schema: object;
  addDir: string;
}) => Promise<{ output: unknown; costUsd: number }>;

let visionBackend: VisionBackend = (req) => claudeVisionCall(req);

/** Test seam, mirroring llm.ts's setBackend. */
export function setVisionBackend(b: VisionBackend): void {
  visionBackend = b;
}

function sha1File(p: string): string {
  return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
}

// Same shape as llmJson's own cacheKey, plus each image's sha1 — a candidate whose keyframes
// were re-extracted with different content (even at the same path) must not hit a stale cache
// entry from a previous run.
function visionCacheKey(model: string, system: string, prompt: string, schema: object, images: string[]): string {
  const imageHashes = images.map((p) => sha1File(p));
  const s = JSON.stringify({ model, system, prompt, schema, imageHashes });
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * Vision-capable counterpart to llm.ts's llmJson: runs the claude CLI with `--tools Read` (plus
 * `--add-dir` for the images' directory) so it can open local image files before answering, and
 * shares llmJson's own cache directory and ledger file (`cachePath`/`logLedger`/`getSemaphore`
 * are re-exported from llm.ts for exactly this reuse) under a cache key that additionally folds
 * in each image's sha1.
 */
export async function llmVisionJson<T>(req: {
  tier: Tier;
  purpose: string;
  system: string;
  prompt: string;
  schema: object;
  images: string[];
  noCache?: boolean;
}): Promise<T> {
  if (req.images.length === 0) throw new Error('llmVisionJson: at least one image is required');

  const model = MODEL[req.tier];
  const key = visionCacheKey(model, req.system, req.prompt, req.schema, req.images);
  const cp = cachePath(key);

  if (!req.noCache) {
    const cached = readJsonOr<{ output: unknown } | null>(cp, null);
    if (cached !== null) {
      logLedger({ at: new Date().toISOString(), tier: req.tier, model, purpose: req.purpose, costUsd: 0, ms: 0, cached: true } satisfies LedgerEntry);
      return cached.output as T;
    }
  }

  // All keyframes for one vision call live together in the same candidate-specific directory
  // (select/visual.ts's visionCheck writes them there), so a single --add-dir covers all of them.
  const addDir = path.dirname(path.resolve(req.images[0]));

  const release = await getSemaphore().acquire();
  const start = Date.now();
  try {
    let result: { output: unknown; costUsd: number };
    try {
      result = await visionBackend({ model, system: req.system, prompt: req.prompt, schema: req.schema, addDir });
    } catch {
      await sleep(3000);
      result = await visionBackend({ model, system: req.system, prompt: req.prompt, schema: req.schema, addDir });
    }
    const ms = Date.now() - start;
    if (!req.noCache) {
      writeJson(cp, { output: result.output });
    }
    logLedger({ at: new Date().toISOString(), tier: req.tier, model, purpose: req.purpose, costUsd: result.costUsd, ms, cached: false } satisfies LedgerEntry);
    return result.output as T;
  } finally {
    release();
  }
}

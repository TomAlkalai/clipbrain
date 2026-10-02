import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from '../config.js';
import { loadCreator, paths, readJson, readJsonOr, writeJson } from '../store.js';
import { loadPlaybook, playbookPromptBlock, type Playbook } from '../playbook/playbook.js';
import { distillFeatures } from '../playbook/distill.js';
import { buildPool } from '../select/select.js';
import { ledgerSummary } from '../llm/llm.js';
import { log } from '../log.js';
import { assertNoLeak, outOfFold, type HeldOutShort } from './folds.js';
import { benchSentences, buildDataset, cachedWords, datasetPath, type BenchDataset, type BenchEpisode, type Segmentation } from './dataset.js';
import type { Candidate, ShortFeatures } from '../types.js';

// Stage 1 of the ranking benchmark (design §7): fold playbooks, then one candidate pool per
// episode built by production's buildPool from the episode's cached captions. Expensive (LLM), so
// everything is cached on disk and the run stops cleanly at the budget or the first LLM failure.

export function benchDir(slug: string): string {
  return path.join(DATA, 'bench', slug);
}
function foldPlaybookPath(slug: string, fold: number): string {
  return path.join(benchDir(slug), 'playbooks', `fold-${fold}.json`);
}
export function poolPath(slug: string, episodeId: string): string {
  return path.join(benchDir(slug), 'pools', `${episodeId}.json`);
}

export type PoolFile = {
  episodeId: string;
  fold: number;
  playbookHash: string;
  segmentation: Segmentation;
  builtAt: string;
  durationMs: number;
  costUsd: number;
  /** The top candidates the ranker sees (production's TOP_POOL). */
  pool: Candidate[];
  /** Every candidate that survived selection, by composite. */
  all: Candidate[];
};

type FoldPlaybookFile = { trainingShortIds: string[]; playbook: Playbook };

/** Identifies a playbook's prompt-relevant content; a pool is rebuilt only when this changes. */
export function playbookHash(pb: Playbook): string {
  return crypto.createHash('sha1').update(playbookPromptBlock(pb) + JSON.stringify(pb.weights)).digest('hex').slice(0, 12);
}

export function loadDataset(slug: string): BenchDataset {
  return fs.existsSync(datasetPath(slug)) ? readJson<BenchDataset>(datasetPath(slug)) : buildDataset(slug);
}

/** Every held-out Short of the episodes in `fold` — none may appear in that fold's playbook. */
export function heldOutOfFold(ds: BenchDataset, fold: number): HeldOutShort[] {
  return ds.episodes.filter((e) => e.fold === fold).flatMap((e) => e.heldOut);
}

export type PoolDeps = { distillFeatures: typeof distillFeatures; buildPool: typeof buildPool };
const defaultDeps: PoolDeps = { distillFeatures, buildPool };

/**
 * One playbook per fold, distilled (balanced tier, once, cached) from the Shorts of the OTHER
 * folds only, keeping production's weights and own results. Each is checked against its fold's
 * held-out Shorts before use.
 */
export async function ensureFoldPlaybooks(slug: string, ds: BenchDataset, deps: PoolDeps = defaultDeps): Promise<Playbook[]> {
  const features = readJsonOr<ShortFeatures[]>(path.join(paths.creator(slug), 'features.json'), []);
  const prior = loadPlaybook(slug);
  const out: Playbook[] = [];
  for (let f = 0; f < ds.folds; f++) {
    const training = outOfFold(features, f, ds.folds);
    const ids = training.map((t) => t.shortId).sort();
    const cached = readJsonOr<FoldPlaybookFile | null>(foldPlaybookPath(slug, f), null);
    let pb: Playbook;
    if (cached && JSON.stringify(cached.trainingShortIds) === JSON.stringify(ids)) {
      pb = cached.playbook;
    } else {
      log(`bench ${slug}: distilling the fold ${f} playbook from ${training.length} out-of-fold Shorts`);
      pb = await deps.distillFeatures(slug, training, prior);
      writeJson(foldPlaybookPath(slug, f), { trainingShortIds: ids, playbook: pb } satisfies FoldPlaybookFile);
    }
    assertNoLeak(playbookPromptBlock(pb), heldOutOfFold(ds, f), `fold ${f} playbook`);
    out.push(pb);
  }
  return out;
}

/** Pilot (design §10): one settled episode with cached captions per fold, chosen deterministically. */
export function pilotEpisodes(ds: BenchDataset): BenchEpisode[] {
  const picks: BenchEpisode[] = [];
  for (let f = 0; f < ds.folds; f++) {
    const inFold = ds.episodes.filter((e) => e.fold === f && e.transcript).sort((a, b) => a.episodeId.localeCompare(b.episodeId));
    const pick = inFold.find((e) => e.young === false) ?? inFold.find((e) => e.young === null) ?? inFold[0];
    if (pick) picks.push(pick);
  }
  return picks;
}

export type PoolsOpts = { pilot?: boolean; episodes?: string[]; maxUsd?: number };
export type PoolsResult = {
  built: string[];
  cached: string[];
  skipped: { episodeId: string; reason: string }[];
  failed: { episodeId: string; error: string } | null;
  stoppedForBudget: boolean;
  /** Spent in this run. */
  spentUsd: number;
  /** Spent on stage 1 in total, across runs — what --max-usd caps. */
  totalUsd: number;
};

/** Stage 1: builds (or reuses) the candidate pool of each selected episode. */
export async function buildPools(slug: string, o: PoolsOpts = {}, deps: PoolDeps = defaultDeps): Promise<PoolsResult> {
  const ds = loadDataset(slug);
  const maxUsd = o.maxUsd ?? 60;
  // The cap covers all of stage 1, across resumed runs (a run stopped by a usage limit must not
  // get a fresh budget): pools already built count with their recorded cost.
  const priorUsd = ds.episodes.reduce((s, e) => s + (readJsonOr<PoolFile | null>(poolPath(slug, e.episodeId), null)?.costUsd ?? 0), 0);
  const startUsd = ledgerSummary().costUsd;
  const spentThisRun = () => ledgerSummary().costUsd - startUsd;
  const spent = () => priorUsd + spentThisRun();
  const result: PoolsResult = { built: [], cached: [], skipped: [], failed: null, stoppedForBudget: false, spentUsd: 0, totalUsd: 0 };

  let targets = o.pilot ? pilotEpisodes(ds) : ds.episodes;
  if (o.episodes?.length) targets = targets.filter((e) => o.episodes!.includes(e.episodeId));
  const creatorName = loadCreator(slug).name;
  const playbooks = await ensureFoldPlaybooks(slug, ds, deps);

  for (const ep of targets) {
    const words = cachedWords(ep.episodeId);
    if (!ep.transcript || !words) {
      result.skipped.push({ episodeId: ep.episodeId, reason: 'no cached captions (re-run `cb mine`)' });
      continue;
    }
    const pb = playbooks[ep.fold];
    const hash = playbookHash(pb);
    const existing = readJsonOr<PoolFile | null>(poolPath(slug, ep.episodeId), null);
    if (existing && existing.playbookHash === hash && existing.segmentation === ep.transcript.segmentation) {
      result.cached.push(ep.episodeId);
      continue;
    }
    if (spent() >= maxUsd) {
      result.stoppedForBudget = true;
      log(`bench ${slug}: stopping — $${spent().toFixed(2)} spent on stage 1 so far reaches the $${maxUsd} cap (raise --max-usd to continue; pools are cached)`);
      break;
    }
    assertNoLeak(playbookPromptBlock(pb), ep.heldOut, `pool for ${ep.episodeId}`);
    const before = ledgerSummary().costUsd;
    const t0 = Date.now();
    try {
      const sentences = benchSentences(words, ep.transcript.segmentation);
      const { pool, all } = await deps.buildPool({ sourceId: `bench_${ep.episodeId}`, title: ep.title, creatorName, pb, sentences, words });
      writeJson(poolPath(slug, ep.episodeId), {
        episodeId: ep.episodeId, fold: ep.fold, playbookHash: hash, segmentation: ep.transcript.segmentation,
        builtAt: new Date().toISOString(), durationMs: Date.now() - t0, costUsd: ledgerSummary().costUsd - before, pool, all,
      } satisfies PoolFile);
      result.built.push(ep.episodeId);
      log(`bench ${slug}: pool for ${ep.episodeId} — ${pool.length} candidates, $${(ledgerSummary().costUsd - before).toFixed(2)}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    } catch (err) {
      // Most likely a usage limit: every later call would fail too. Stop; finished pools are kept.
      result.failed = { episodeId: ep.episodeId, error: err instanceof Error ? err.message : String(err) };
      log(`bench ${slug}: stopping at ${ep.episodeId} — ${result.failed.error} (re-run to resume)`);
      break;
    }
  }
  result.spentUsd = spentThisRun();
  result.totalUsd = spent();
  return result;
}

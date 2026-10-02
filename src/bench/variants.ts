import fs from 'node:fs';
import path from 'node:path';
import { loadCreator, paths, readJsonOr, writeJson } from '../store.js';
import { playbookPromptBlock, type Playbook } from '../playbook/playbook.js';
import { finalRank, topAudienceExamples, type RankOpts } from '../select/rank.js';
import { composite } from '../select/snap.js';
import { ledgerSummary } from '../llm/llm.js';
import { log } from '../log.js';
import { SIGNALS } from '../types.js';
import { assertNoLeak, outOfFold } from './folds.js';
import { episodeMetrics, type OfficialMoment } from './metrics.js';
import { benchSentences, cachedWords, type BenchDataset } from './dataset.js';
import { benchDir, ensureFoldPlaybooks, loadDataset, poolPath, type PoolFile } from './pools.js';
import type { Candidate, ShortFeatures, SignalName } from '../types.js';

// Stage 2 of the ranking benchmark (design §7): every variant orders the SAME frozen pools.

export type VariantId = 'V0' | 'V1' | 'V2' | 'V3' | 'B-comp' | 'W-cv';
export const LLM_VARIANTS: VariantId[] = ['V0', 'V1', 'V2', 'V3'];
export const DEFAULT_VARIANTS: VariantId[] = ['V0', 'B-comp', 'V1', 'V2', 'W-cv'];
export const VARIANT_INFO: Record<VariantId, string> = {
  V0: 'production final rank (fold playbook + out-of-fold audience examples)',
  V1: 'V0 without per-signal scores and composite (anchoring test)',
  V2: 'V0 without audience examples',
  V3: 'V0 on the balanced tier (cost comparison)',
  'B-comp': 'sort by composite (production weights)',
  'W-cv': 'composite with weights learned leave-one-episode-out',
};
const AUDIENCE_EXAMPLES_N = 10; // same as production selection
const SHORTLIST_N = 6; // production --top

export type RankingFile = {
  variant: VariantId;
  repeat: number;
  episodeId: string;
  /** The whole pool, best first: the ranker's picks, then the rest by composite. */
  ranked: string[];
  costUsd: number;
  durationMs: number;
  at: string;
  weights?: Record<SignalName, number>;
};

export function rankingKey(variant: VariantId, repeat: number): string {
  return repeat === 0 ? variant : `${variant}@r${repeat}`;
}
export function rankingPath(slug: string, key: string, episodeId: string): string {
  return path.join(benchDir(slug), 'rankings', key, `${episodeId}.json`);
}

export function byComposite(cands: Candidate[], weights?: Record<SignalName, number>): Candidate[] {
  const score = (c: Candidate) => (weights ? composite(c.scores, weights) : c.composite);
  return [...cands].sort((a, b) => score(b) - score(a) || a.start - b.start);
}

/** The model's picks (unknown/repeated ids dropped), then the rest of the pool by composite. */
export function completeRanking(pool: Candidate[], picked: string[]): string[] {
  const known = new Set(pool.map((c) => c.id));
  const head: string[] = [];
  for (const id of picked) if (known.has(id) && !head.includes(id)) head.push(id);
  return [...head, ...byComposite(pool).map((c) => c.id).filter((id) => !head.includes(id))];
}

const WEIGHT_GRID = [0.25, 0.5, 0.75, 1, 1.5, 2, 3]; // learn.ts clamps weights to [0.25, 3]

function meanNdcg(train: { pool: Candidate[]; moments: OfficialMoment[] }[], w: Record<SignalName, number>): number {
  const xs = train.map((t) => episodeMetrics(byComposite(t.pool, w), t.moments).ndcgPool).filter((x): x is number => x !== null);
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

/**
 * Signal weights maximizing mean nDCG@6|pool of composite ranking over the training episodes:
 * coordinate search over a fixed grid, starting from equal weights. A change must strictly improve
 * the objective, so with no signal in the data the weights stay at 1. Pure.
 */
export function fitWeights(train: { pool: Candidate[]; moments: OfficialMoment[] }[], passes = 3): Record<SignalName, number> {
  const w = Object.fromEntries(SIGNALS.map((s) => [s, 1])) as Record<SignalName, number>;
  let best = meanNdcg(train, w);
  for (let p = 0; p < passes; p++) {
    let improved = false;
    for (const s of SIGNALS) {
      for (const v of WEIGHT_GRID) {
        if (v === w[s]) continue;
        const trial = { ...w, [s]: v };
        const score = meanNdcg(train, trial);
        if (score > best + 1e-9) {
          best = score;
          w[s] = v;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return w;
}

export type RankVariantsResult = { written: number; costUsd: number; failed: { key: string; episodeId: string; error: string } | null };

/** Stage 2: writes one ranking per (variant, repeat, episode with a pool). */
export async function rankVariants(
  slug: string,
  o: { variants?: VariantId[]; repeats?: number } = {},
  deps: { finalRank: typeof finalRank } = { finalRank },
): Promise<RankVariantsResult> {
  const ds: BenchDataset = loadDataset(slug);
  const pools = ds.episodes
    .map((ep) => ({ ep, file: readJsonOr<PoolFile | null>(poolPath(slug, ep.episodeId), null) }))
    .filter((x): x is { ep: (typeof ds.episodes)[number]; file: PoolFile } => x.file !== null);
  if (pools.length === 0) throw new Error(`no pools for "${slug}" yet — run \`cb bench pools ${slug}\` first`);

  const variants = o.variants ?? DEFAULT_VARIANTS;
  const startUsd = ledgerSummary().costUsd;
  const result: RankVariantsResult = { written: 0, costUsd: 0, failed: null };
  const save = (key: string, f: RankingFile) => {
    writeJson(rankingPath(slug, key, f.episodeId), f);
    result.written++;
  };
  const now = () => new Date().toISOString();

  if (variants.includes('B-comp')) {
    for (const { ep, file } of pools) {
      save('B-comp', { variant: 'B-comp', repeat: 0, episodeId: ep.episodeId, ranked: byComposite(file.pool).map((c) => c.id), costUsd: 0, durationMs: 0, at: now() });
    }
  }
  if (variants.includes('W-cv')) {
    for (const { ep, file } of pools) {
      const train = pools.filter((p) => p.ep.episodeId !== ep.episodeId).map((p) => ({ pool: p.file.pool, moments: p.ep.moments }));
      const weights = fitWeights(train);
      save('W-cv', { variant: 'W-cv', repeat: 0, episodeId: ep.episodeId, ranked: byComposite(file.pool, weights).map((c) => c.id), costUsd: 0, durationMs: 0, at: now(), weights });
    }
  }

  const llm = variants.filter((v) => LLM_VARIANTS.includes(v));
  if (llm.length > 0) {
    const playbooks: Playbook[] = await ensureFoldPlaybooks(slug, ds);
    const features = readJsonOr<ShortFeatures[]>(path.join(paths.creator(slug), 'features.json'), []);
    const creatorName = loadCreator(slug).name;
    outer: for (const variant of llm) {
      for (let r = 0; r <= (o.repeats ?? 0); r++) {
        const key = rankingKey(variant, r);
        for (const { ep, file } of pools) {
          if (r === 0 && fs.existsSync(rankingPath(slug, key, ep.episodeId))) continue; // cached; repeats always re-run
          const pbBlock = playbookPromptBlock(playbooks[ep.fold]);
          const audience = variant === 'V2' ? [] : topAudienceExamples(outOfFold(features, ep.fold, ds.folds), AUDIENCE_EXAMPLES_N);
          assertNoLeak(`${pbBlock}\n${audience.map((a) => a.title).join('\n')}`, ep.heldOut, `${key} prompt for ${ep.episodeId}`);
          const words = cachedWords(ep.episodeId) ?? [];
          const sentences = benchSentences(words, file.segmentation);
          const opts: RankOpts = { showScores: variant !== 'V1', tier: variant === 'V3' ? 'balanced' : 'strong', noCache: r > 0 };
          const before = ledgerSummary().costUsd;
          const t0 = Date.now();
          try {
            const picked = await deps.finalRank(file.pool, sentences, creatorName, pbBlock, Math.min(SHORTLIST_N, file.pool.length), audience, opts);
            save(key, {
              variant, repeat: r, episodeId: ep.episodeId, ranked: completeRanking(file.pool, picked.map((p) => p.id)),
              costUsd: ledgerSummary().costUsd - before, durationMs: Date.now() - t0, at: now(),
            });
          } catch (err) {
            result.failed = { key, episodeId: ep.episodeId, error: err instanceof Error ? err.message : String(err) };
            log(`bench ${slug}: ${key} stopped at ${ep.episodeId} — ${result.failed.error} (re-run to resume)`);
            break outer;
          }
        }
      }
    }
  }
  result.costUsd = ledgerSummary().costUsd - startUsd;
  return result;
}

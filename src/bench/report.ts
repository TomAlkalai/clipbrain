import fs from 'node:fs';
import path from 'node:path';
import { readJsonOr, writeJson } from '../store.js';
import { spearman } from '../learn/learn.js';
import { SIGNALS } from '../types.js';
import { bootstrapMean, coverage, episodeMetrics, MATCH_COVERAGE, pairedBootstrap, randomBaseline, type EpisodeMetrics, type Interval } from './metrics.js';
import { benchDir, loadDataset, poolPath, type PoolFile } from './pools.js';
import { VARIANT_INFO, type RankingFile, type VariantId } from './variants.js';
import type { BenchDataset, BenchEpisode } from './dataset.js';
import type { Candidate, SignalName } from '../types.js';

// Stage 3 of the ranking benchmark (design §5, §8): aggregates, paired comparisons against V0,
// the noise floor, the promotion decision rule, and per-signal correlations. Pure core + file I/O.

const METRICS = ['ndcgPool', 'ndcgAll', 'precision', 'recall', 'mrr'] as const;
type MetricName = (typeof METRICS)[number];

export type VariantSummary = {
  key: string;
  label: string;
  episodes: number;
  metrics: Record<MetricName, Interval>;
  costPerEpisode: number;
  msPerEpisode: number;
};
export type Comparison = {
  key: string;
  dNdcgPool: Interval;
  dRecall: Interval;
  dNdcgPoolSettled: Interval;
  costRatio: number | null;
  checks: { beatsV0: boolean; recallNotWorse: boolean; holdsOnSettled: boolean; costOk: boolean };
  promote: boolean;
};
export type BenchReport = {
  slug: string;
  at: string;
  episodes: { episodeId: string; title: string; fold: number; young: boolean | null; official: number; poolSize: number; poolRecall: number; ndcgPool: Record<string, number | null> }[];
  pools: { episodes: number; poolRecall: Interval; meanPoolSize: number; costUsd: number; durationMs: number };
  variants: VariantSummary[];
  comparisons: Comparison[];
  noiseFloor: number | null;
  signals: { signal: SignalName; rho: number; n: number }[];
};

export type ReportInput = { ds: BenchDataset; pools: Map<string, PoolFile>; rankings: Map<string, Map<string, RankingFile>>; at: string };

function spansOf(pool: Candidate[], ids: string[]): Candidate[] {
  const byId = new Map(pool.map((c) => [c.id, c]));
  return ids.map((id) => byId.get(id)).filter((c): c is Candidate => c !== undefined);
}

function intervalOf(xs: (number | null)[]): Interval {
  return bootstrapMean(xs.filter((x): x is number => x !== null));
}

/** Pure: the whole report from the dataset, the pools and every ranking. */
export function computeReport(i: ReportInput): BenchReport {
  const eps: BenchEpisode[] = i.ds.episodes.filter((e) => i.pools.has(e.episodeId));
  const metricsFor = new Map<string, Map<string, EpisodeMetrics>>(); // key -> episode -> metrics
  for (const [key, byEp] of i.rankings) {
    const m = new Map<string, EpisodeMetrics>();
    for (const ep of eps) {
      const r = byEp.get(ep.episodeId);
      if (r) m.set(ep.episodeId, episodeMetrics(spansOf(i.pools.get(ep.episodeId)!.pool, r.ranked), ep.moments));
    }
    metricsFor.set(key, m);
  }
  const rand = new Map(eps.map((ep) => [ep.episodeId, randomBaseline(i.pools.get(ep.episodeId)!.pool, ep.moments)]));
  metricsFor.set('B-rand', rand);

  const keys = [...metricsFor.keys()].sort((a, b) => (a === 'V0' ? -1 : b === 'V0' ? 1 : a.localeCompare(b)));
  const series = (key: string, metric: MetricName, only?: (ep: BenchEpisode) => boolean) =>
    eps.map((ep) => (only && !only(ep) ? null : (metricsFor.get(key)?.get(ep.episodeId)?.[metric] ?? null)));

  const variants: VariantSummary[] = keys.map((key) => {
    const files = [...(i.rankings.get(key)?.values() ?? [])].filter((f) => i.pools.has(f.episodeId));
    const base = key.split('@')[0];
    return {
      key,
      label: key === 'B-rand' ? 'random order (seeded simulation)' : (VARIANT_INFO[base as VariantId] ?? base) + (key.includes('@') ? ' — repeat' : ''),
      episodes: metricsFor.get(key)!.size,
      metrics: Object.fromEntries(METRICS.map((m) => [m, intervalOf(series(key, m))])) as Record<MetricName, Interval>,
      costPerEpisode: files.length ? files.reduce((s, f) => s + f.costUsd, 0) / files.length : 0,
      msPerEpisode: files.length ? files.reduce((s, f) => s + f.durationMs, 0) / files.length : 0,
    };
  });

  const repeats = keys.filter((k) => k.startsWith('V0@'));
  const noiseFloor = repeats.length
    ? Math.max(...repeats.map((k) => Math.abs(pairedBootstrap(series('V0', 'ndcgPool'), series(k, 'ndcgPool')).mean)).filter(Number.isFinite), 0)
    : null;
  const v0Cost = variants.find((v) => v.key === 'V0')?.costPerEpisode ?? 0;
  const settled = (ep: BenchEpisode) => ep.young !== true;

  const comparisons: Comparison[] = metricsFor.has('V0')
    ? keys.filter((k) => k !== 'V0' && !k.includes('@')).map((key) => {
        const dNdcgPool = pairedBootstrap(series(key, 'ndcgPool'), series('V0', 'ndcgPool'));
        const dRecall = pairedBootstrap(series(key, 'recall'), series('V0', 'recall'));
        const dNdcgPoolSettled = pairedBootstrap(series(key, 'ndcgPool', settled), series('V0', 'ndcgPool', settled));
        const cost = variants.find((v) => v.key === key)?.costPerEpisode ?? 0;
        const costRatio = v0Cost > 0 ? cost / v0Cost : null;
        const checks = {
          beatsV0: dNdcgPool.n > 0 && dNdcgPool.lo > 0 && dNdcgPool.mean > (noiseFloor ?? 0),
          recallNotWorse: dRecall.n > 0 && dRecall.hi >= 0,
          holdsOnSettled: dNdcgPoolSettled.n > 0 && dNdcgPoolSettled.lo > 0,
          costOk: costRatio === null || costRatio <= 1.5,
        };
        return { key, dNdcgPool, dRecall, dNdcgPoolSettled, costRatio, checks, promote: Object.values(checks).every(Boolean) };
      })
    : [];

  // Which first-pass signals actually predict the channel's picks: score vs credited relevance gain.
  const pairs: { scores: Candidate['scores']; y: number }[] = [];
  for (const ep of eps) {
    for (const c of i.pools.get(ep.episodeId)!.pool) {
      const gains = ep.moments.filter((m) => coverage(c, m.segments) >= MATCH_COVERAGE).map((m) => 2 ** m.grade - 1);
      pairs.push({ scores: c.scores, y: gains.length ? Math.max(...gains) : 0 });
    }
  }
  const signals = SIGNALS.map((s) => ({ signal: s, rho: spearman(pairs.map((p) => p.scores[s].score), pairs.map((p) => p.y)), n: pairs.length }));

  const poolFiles = eps.map((ep) => i.pools.get(ep.episodeId)!);
  return {
    slug: i.ds.slug,
    at: i.at,
    episodes: eps.map((ep) => ({
      episodeId: ep.episodeId, title: ep.title, fold: ep.fold, young: ep.young, official: ep.moments.length,
      poolSize: i.pools.get(ep.episodeId)!.pool.length,
      poolRecall: rand.get(ep.episodeId)!.poolRecall,
      ndcgPool: Object.fromEntries(keys.filter((k) => !k.includes('@')).map((k) => [k, metricsFor.get(k)?.get(ep.episodeId)?.ndcgPool ?? null])),
    })),
    pools: {
      episodes: eps.length,
      poolRecall: intervalOf(eps.map((ep) => rand.get(ep.episodeId)!.poolRecall)),
      meanPoolSize: poolFiles.reduce((s, p) => s + p.pool.length, 0) / Math.max(1, poolFiles.length),
      costUsd: poolFiles.reduce((s, p) => s + p.costUsd, 0),
      durationMs: poolFiles.reduce((s, p) => s + p.durationMs, 0),
    },
    variants,
    comparisons,
    noiseFloor,
    signals,
  };
}

const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '–');
const ci = (v: Interval) => (v.n === 0 ? '–' : `${f2(v.mean)} [${f2(v.lo)}, ${f2(v.hi)}]`);
const signed = (v: Interval) => (v.n === 0 ? '–' : `${v.mean >= 0 ? '+' : ''}${f2(v.mean)} [${f2(v.lo)}, ${f2(v.hi)}]`);
const yes = (b: boolean) => (b ? '✅' : '❌');

/** Pure: report.md. */
export function renderReportMd(r: BenchReport): string {
  const L: string[] = [];
  L.push(`# Ranking benchmark — ${r.slug}`, '', `_${r.at}_ · ${r.pools.episodes} episode(s) · official Shorts are one team's picks, not ground truth._`, '');
  if (r.pools.episodes < 10) L.push(`> **Only ${r.pools.episodes} episode(s)**: confidence intervals are very wide. Read this as a pipeline and cost check, not a verdict.`, '');
  L.push('## Candidate pools (stage 1)', '');
  L.push(`- Pool recall (share of official moments any candidate reaches): **${ci(r.pools.poolRecall)}**`);
  L.push(`- Mean pool size: ${r.pools.meanPoolSize.toFixed(1)} candidates`);
  L.push(`- Cost: $${r.pools.costUsd.toFixed(2)} total, $${(r.pools.costUsd / Math.max(1, r.pools.episodes)).toFixed(2)} per episode (plan usage, as reported by Claude Code; $0 for cached calls)`);
  L.push(`- Time: ${(r.pools.durationMs / 60000).toFixed(1)} min total, ${(r.pools.durationMs / 60000 / Math.max(1, r.pools.episodes)).toFixed(1)} min per episode`, '');
  L.push('## Variants (mean [95 % CI] over episodes)', '');
  L.push('| variant | what | nDCG@6 \\| pool | nDCG@6 \\| all | P@6 | R@6 | MRR | $/episode |', '|---|---|---|---|---|---|---|---|');
  for (const v of r.variants) {
    const m = v.metrics;
    L.push(`| ${v.key} | ${v.label} | ${ci(m.ndcgPool)} | ${ci(m.ndcgAll)} | ${ci(m.precision)} | ${ci(m.recall)} | ${ci(m.mrr)} | ${v.costPerEpisode.toFixed(2)} |`);
  }
  L.push('', '## Against the production ranker (V0) — paired, design §8', '');
  L.push(`Noise floor (V0 re-run vs itself): ${r.noiseFloor === null ? 'not measured (run `bench rank --repeat 1`)' : f2(r.noiseFloor)}`, '');
  if (r.comparisons.length === 0) {
    L.push('V0 has not been run yet.');
  } else {
    L.push('| variant | Δ nDCG@6 \\| pool | Δ R@6 | Δ nDCG (settled eps) | cost ×V0 | beats V0 | recall ok | holds settled | cost ok | **promote** |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const c of r.comparisons) {
      L.push(`| ${c.key} | ${signed(c.dNdcgPool)} | ${signed(c.dRecall)} | ${signed(c.dNdcgPoolSettled)} | ${c.costRatio === null ? 'n/a' : c.costRatio.toFixed(2)} | ${yes(c.checks.beatsV0)} | ${yes(c.checks.recallNotWorse)} | ${yes(c.checks.holdsOnSettled)} | ${yes(c.checks.costOk)} | ${c.promote ? '**yes**' : 'no'} |`);
    }
  }
  L.push('', '## Which first-pass signals predict the channel\'s picks', '', '| signal | Spearman ρ vs relevance | n candidates |', '|---|---|---|');
  for (const s of [...r.signals].sort((a, b) => b.rho - a.rho)) L.push(`| ${s.signal} | ${f2(s.rho)} | ${s.n} |`);
  const keys = r.episodes.length ? Object.keys(r.episodes[0].ndcgPool) : [];
  L.push('', '## Per episode (nDCG@6 | pool)', '', `| episode | fold | young | official | pool | pool recall | ${keys.join(' | ')} | title |`, `|---|---|---|---|---|---|${keys.map(() => '---|').join('')}---|`);
  for (const e of r.episodes) {
    L.push(`| ${e.episodeId} | ${e.fold} | ${e.young ?? '?'} | ${e.official} | ${e.poolSize} | ${f2(e.poolRecall)} | ${keys.map((k) => (e.ndcgPool[k] === null ? '–' : f2(e.ndcgPool[k]!))).join(' | ')} | ${e.title.slice(0, 40)} |`);
  }
  return L.join('\n') + '\n';
}

export function reportPaths(slug: string): { md: string; json: string } {
  const dir = path.join(benchDir(slug), 'report');
  return { md: path.join(dir, 'report.md'), json: path.join(dir, 'summary.json') };
}

/** Stage 3: loads pools and rankings from disk, writes report.md + summary.json, returns the report. */
export function writeReport(slug: string): BenchReport {
  const ds = loadDataset(slug);
  const pools = new Map<string, PoolFile>();
  for (const ep of ds.episodes) {
    const p = readJsonOr<PoolFile | null>(poolPath(slug, ep.episodeId), null);
    if (p) pools.set(ep.episodeId, p);
  }
  if (pools.size === 0) throw new Error(`no pools for "${slug}" yet — run \`cb bench pools ${slug}\` first`);
  const rankings = new Map<string, Map<string, RankingFile>>();
  const rankDir = path.join(benchDir(slug), 'rankings');
  for (const key of fs.existsSync(rankDir) ? fs.readdirSync(rankDir) : []) {
    const byEp = new Map<string, RankingFile>();
    for (const f of fs.readdirSync(path.join(rankDir, key))) {
      const r = readJsonOr<RankingFile | null>(path.join(rankDir, key, f), null);
      if (r) byEp.set(r.episodeId, r);
    }
    rankings.set(key, byEp);
  }
  const report = computeReport({ ds, pools, rankings, at: new Date().toISOString() });
  const out = reportPaths(slug);
  writeJson(out.json, report);
  fs.writeFileSync(out.md, renderReportMd(report));
  return report;
}

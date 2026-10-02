// Pure scoring for the offline ranking benchmark
// (docs/superpowers/specs/2026-09-29-ranking-benchmark-design.md §4–§5). No I/O, no LLM.

export type Span = { start: number; end: number };
export type Grade = 1 | 2 | 3;
export type OfficialMoment = { shortId: string; title: string; perf: number | null; grade: Grade; segments: Span[] };

/** A candidate matches an official moment when it covers at least this share of its source material. */
export const MATCH_COVERAGE = 0.3;
const LN2 = Math.log(2);

/**
 * Share of an official moment's aligned source segments that fall inside the candidate. Per
 * segment rather than over min→max: a cold-open Short lifted from much later in the episode would
 * otherwise stretch the moment across half an hour and never be matched.
 */
export function coverage(c: Span, segments: Span[]): number {
  let total = 0;
  let inside = 0;
  for (const s of segments) {
    total += Math.max(0, s.end - s.start);
    inside += Math.max(0, Math.min(c.end, s.end) - Math.max(c.start, s.start));
  }
  return total <= 0 ? 0 : inside / total;
}

/** perf = ln(views / channel median): ≥ 2× median → 3, ≥ median → 2, below or unknown → 1. */
export function gradeOf(perf: number | null): Grade {
  if (perf === null || !Number.isFinite(perf)) return 1;
  if (perf >= LN2 - 1e-12) return 3;
  return perf >= 0 ? 2 : 1;
}

function gainOf(g: Grade, graded: boolean): number {
  return graded ? 2 ** g - 1 : 1;
}

export type MetricOpts = { k?: number; threshold?: number; graded?: boolean };
export type EpisodeMetrics = {
  nOfficial: number;
  nMatchedInPool: number;
  poolRecall: number;
  /** DCG@k over the best DCG achievable from the moments this pool reaches; null if it reaches none. */
  ndcgPool: number | null;
  ndcgAll: number;
  precision: number;
  recall: number;
  mrr: number;
};

function dcg(gains: number[], k: number): number {
  let s = 0;
  for (let i = 0; i < Math.min(k, gains.length); i++) s += gains[i] / Math.log2(i + 2);
  return s;
}

/**
 * Scores one variant's ordering of an episode's candidate pool against the official moments.
 * `ranked` is the whole pool in the variant's order (the pool itself is its set of items).
 * Each official moment is credited once, to its best-placed match, and a position credits at most
 * one moment — ranking two near-duplicates of the same idea earns nothing extra. The ideal for
 * nDCG|pool sorts the gains of the moments the pool reaches (an upper bound; exact unless one
 * candidate is the only match for two moments).
 */
export function episodeMetrics(ranked: Span[], moments: OfficialMoment[], o: MetricOpts = {}): EpisodeMetrics {
  const k = o.k ?? 6;
  const thr = o.threshold ?? MATCH_COVERAGE;
  const graded = o.graded ?? true;
  const cov = ranked.map((c) => moments.map((m) => coverage(c, m.segments)));
  const matches = (ci: number, mi: number): boolean => cov[ci][mi] >= thr;
  const gains = moments.map((m) => gainOf(m.grade, graded));

  const credited = new Set<number>();
  const positionGains: number[] = [];
  for (let ci = 0; ci < Math.min(k, ranked.length); ci++) {
    let best = -1;
    for (let mi = 0; mi < moments.length; mi++) {
      if (!matches(ci, mi) || credited.has(mi)) continue;
      if (best === -1 || gains[mi] > gains[best] || (gains[mi] === gains[best] && cov[ci][mi] > cov[ci][best])) best = mi;
    }
    if (best !== -1) credited.add(best);
    positionGains.push(best === -1 ? 0 : gains[best]);
  }

  const reached = moments.map((_, mi) => ranked.some((_, ci) => matches(ci, mi)));
  const inTopK = moments.map((_, mi) => ranked.slice(0, k).some((_, ci) => matches(ci, mi)));
  const byGainDesc = (xs: number[]) => [...xs].sort((a, b) => b - a);
  const idcgPool = dcg(byGainDesc(gains.filter((_, mi) => reached[mi])), k);
  const idcgAll = dcg(byGainDesc(gains), k);
  const got = dcg(positionGains, k);

  const topK = ranked.slice(0, k);
  const relevantAt = (ci: number) => moments.some((_, mi) => matches(ci, mi));
  const firstHit = ranked.findIndex((_, ci) => relevantAt(ci));
  const nMatchedInPool = reached.filter(Boolean).length;
  const n = moments.length;
  return {
    nOfficial: n,
    nMatchedInPool,
    poolRecall: n === 0 ? 0 : nMatchedInPool / n,
    ndcgPool: idcgPool > 0 ? got / idcgPool : null,
    ndcgAll: idcgAll > 0 ? got / idcgAll : 0,
    precision: topK.length === 0 ? 0 : topK.filter((_, ci) => relevantAt(ci)).length / topK.length,
    recall: n === 0 ? 0 : inTopK.filter(Boolean).length / n,
    mrr: firstHit === -1 ? 0 : 1 / (firstHit + 1),
  };
}

/** Deterministic PRNG (mulberry32) returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(xs: T[], rand: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Expected metrics for a random ordering of the pool (seeded Monte Carlo). */
export function randomBaseline(pool: Span[], moments: OfficialMoment[], o: MetricOpts = {}, iters = 2000, seed = 1): EpisodeMetrics {
  const rand = mulberry32(seed);
  const runs = Array.from({ length: iters }, () => episodeMetrics(shuffled(pool, rand), moments, o));
  const avg = (f: (m: EpisodeMetrics) => number) => runs.reduce((s, m) => s + f(m), 0) / runs.length;
  return {
    nOfficial: moments.length,
    nMatchedInPool: runs[0]?.nMatchedInPool ?? 0,
    poolRecall: avg((m) => m.poolRecall),
    ndcgPool: runs[0]?.ndcgPool === null || runs.length === 0 ? null : avg((m) => m.ndcgPool as number),
    ndcgAll: avg((m) => m.ndcgAll),
    precision: avg((m) => m.precision),
    recall: avg((m) => m.recall),
    mrr: avg((m) => m.mrr),
  };
}

export type Interval = { mean: number; lo: number; hi: number; n: number };

/** Mean with a percentile bootstrap 95 % CI over the given per-episode values (seeded). */
export function bootstrapMean(values: number[], iters = 10000, seed = 1): Interval {
  const n = values.length;
  if (n === 0) return { mean: NaN, lo: NaN, hi: NaN, n: 0 };
  const mean = values.reduce((s, x) => s + x, 0) / n;
  const rand = mulberry32(seed);
  const means: number[] = [];
  for (let it = 0; it < iters; it++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += values[Math.floor(rand() * n)];
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor(0.025 * iters)];
  const hi = means[Math.max(0, Math.ceil(0.975 * iters) - 1)];
  return { mean, lo: Math.min(lo, mean), hi: Math.max(hi, mean), n };
}

/**
 * Paired comparison of two variants over the same episodes: bootstraps the per-episode
 * differences (a − b), skipping episodes where either value is null (e.g. nDCG|pool undefined).
 */
export function pairedBootstrap(a: (number | null)[], b: (number | null)[], iters = 10000, seed = 1): Interval {
  if (a.length !== b.length) throw new Error('pairedBootstrap: both variants must be scored on the same episodes');
  const diffs: number[] = [];
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x !== null && y !== null) diffs.push(x - y);
  }
  return bootstrapMean(diffs, iters, seed);
}

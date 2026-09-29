import { listClips } from '../store.js';
import { loadPlaybook, savePlaybook } from '../playbook/playbook.js';
import { SIGNALS } from '../types.js';
import type { Clip, Scores, SignalName } from '../types.js';
import type { OwnResults } from '../playbook/playbook.js';

// --- spearman rank correlation (average ranks for ties) -------------------

function averageRanks(xs: number[]): number[] {
  const n = xs.length;
  const order = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
  const ranks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && xs[order[j + 1]] === xs[order[i]]) j++;
    const avgRank = (i + j) / 2 + 1; // 1-based average rank across the tied run
    for (let k = i; k <= j; k++) ranks[order[k]] = avgRank;
    i = j + 1;
  }
  return ranks;
}

export function spearman(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n === 0 || xs.length !== ys.length) return 0;
  const rx = averageRanks(xs);
  const ry = averageRanks(ys);
  const meanX = rx.reduce((a, b) => a + b, 0) / n;
  const meanY = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = rx[i] - meanX;
    const dy = ry[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  if (denX === 0 || denY === 0) return 0;
  return num / Math.sqrt(denX * denY);
}

// --- outcomes: published performance from metrics --------------------------

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function zscore(xs: number[]): number[] {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  if (std === 0) return xs.map(() => 0);
  return xs.map((x) => (x - mean) / std);
}

const SEVENTY_TWO_HOURS_MS = 72 * 60 * 60 * 1000;

export function outcomes(clips: Clip[], now: Date): { clip: Clip; perf: number }[] {
  const eligible = clips.filter((c) => {
    if (c.status !== 'published' || !c.publish || !c.metrics || c.metrics.length === 0) return false;
    const publishedAt = new Date(c.publish.at).getTime();
    return now.getTime() - publishedAt >= SEVENTY_TWO_HOURS_MS;
  });
  if (eligible.length === 0) return [];

  const latest = (c: Clip) => c.metrics![c.metrics!.length - 1];
  const viewsArr = eligible.map((c) => Math.max(0, latest(c).views));
  const medianViews = Math.max(1, median(viewsArr));
  const lnPerf = viewsArr.map((v) => Math.log(Math.max(v, 1) / medianViews));

  const allHaveAvgViewPct = eligible.every((c) => latest(c).avgViewPct !== undefined);
  let perfs = lnPerf;
  if (allHaveAvgViewPct) {
    const pcts = eligible.map((c) => latest(c).avgViewPct as number);
    const zs = zscore(pcts);
    perfs = lnPerf.map((v, i) => 0.5 * v + 0.5 * zs[i]);
  }

  return eligible.map((c, i) => ({ clip: c, perf: perfs[i] }));
}

// --- updateWeights -----------------------------------------------------------

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function updateWeights(
  prior: Record<SignalName, number>,
  samples: { scores: Scores; y: number }[],
): { weights: Record<SignalName, number>; correlations: Partial<Record<SignalName, { rho: number; n: number }>> } {
  const n = samples.length;
  if (n < 8) return { weights: prior, correlations: {} };

  const ys = samples.map((s) => s.y);
  const weights = {} as Record<SignalName, number>;
  const correlations: Partial<Record<SignalName, { rho: number; n: number }>> = {};

  for (const signal of SIGNALS) {
    const xs = samples.map((s) => s.scores[signal].score);
    const rho = spearman(xs, ys);
    weights[signal] = clamp(1 + (2 * rho * n) / (n + 20), 0.25, 3);
    correlations[signal] = { rho, n };
  }

  return { weights, correlations };
}

// --- buckets -----------------------------------------------------------------

function durationBucket(sec: number): string {
  if (sec < 30) return '<30';
  if (sec < 45) return '30-45';
  if (sec < 60) return '45-60';
  return '>=60';
}

function clipDurationSec(clip: Clip): number {
  if (clip.edl) return clip.edl.durationSec;
  const cold = clip.coldOpen ? clip.coldOpen.end - clip.coldOpen.start : 0;
  return clip.end - clip.start + cold;
}

function dominantLayoutKind(clip: Clip): string {
  const segs = clip.edl?.segments ?? [];
  if (segs.length === 0) return 'unknown';
  const totals = new Map<string, number>();
  for (const s of segs) {
    const dur = s.srcEnd - s.srcStart;
    totals.set(s.layout.kind, (totals.get(s.layout.kind) ?? 0) + dur);
  }
  let best = 'unknown';
  let bestDur = -1;
  for (const [k, d] of totals) {
    if (d > bestDur) {
      best = k;
      bestDur = d;
    }
  }
  return best;
}

function clipFeatures(clip: Clip): { feature: string; value: string }[] {
  return [
    { feature: 'coldOpen', value: clip.coldOpen ? 'yes' : 'no' },
    { feature: 'duration', value: durationBucket(clipDurationSec(clip)) },
    { feature: 'hookPattern', value: clip.hooks[clip.hookIndex]?.pattern ?? 'unknown' },
    { feature: 'layout', value: dominantLayoutKind(clip) },
  ];
}

export function buckets(rows: { clip: Clip; y: number }[]): OwnResults['buckets'] {
  const groups = new Map<string, { feature: string; value: string; ys: number[] }>();
  for (const row of rows) {
    for (const f of clipFeatures(row.clip)) {
      const key = `${f.feature}::${f.value}`;
      let g = groups.get(key);
      if (!g) {
        g = { feature: f.feature, value: f.value, ys: [] };
        groups.set(key, g);
      }
      g.ys.push(row.y);
    }
  }

  const result: OwnResults['buckets'] = [];
  for (const g of groups.values()) {
    if (g.ys.length < 3) continue;
    const meanPerf = g.ys.reduce((a, b) => a + b, 0) / g.ys.length;
    result.push({ feature: g.feature, value: g.value, n: g.ys.length, meanPerf });
  }
  return result;
}

// --- findings ------------------------------------------------------------------

function featureLabel(feature: string, value: string): string {
  switch (feature) {
    case 'coldOpen':
      return value === 'yes' ? 'Clips with cold opens' : 'Clips without cold opens';
    case 'duration':
      return `Clips ${value}s`;
    case 'hookPattern':
      return `Clips with the "${value}" hook pattern`;
    case 'layout':
      return `Clips with "${value}" layout`;
    default:
      return `${feature}=${value}`;
  }
}

function findingLine(b: OwnResults['buckets'][number]): string {
  const sign = b.meanPerf >= 0 ? '+' : '';
  return `${featureLabel(b.feature, b.value)}: ${sign}${b.meanPerf.toFixed(2)} vs median (n=${b.n})`;
}

// --- learn: combine outcomes + review labels into the playbook -----------------

export async function learn(slug: string): Promise<OwnResults> {
  const pb = loadPlaybook(slug);
  const now = new Date();
  const clips = listClips((c) => c.creator === slug);

  const outcomeRows = outcomes(clips, now);
  const reviewed = clips.filter((c) => c.review);
  const rejectionNotes = reviewed
    .filter((c) => c.review!.decision === 'rejected' && c.review!.reason)
    .map((c) => c.review!.reason as string)
    .slice(-20);

  let samples: { scores: Scores; y: number }[];
  if (outcomeRows.length >= 8) {
    samples = outcomeRows.map((r) => ({ scores: r.clip.scores, y: r.perf }));
  } else {
    const reviewSamples = reviewed.map((c) => ({ scores: c.scores, y: c.review!.decision === 'approved' ? 1 : -1 }));
    samples = reviewSamples.length >= 8 ? reviewSamples : [];
  }

  const { weights, correlations } = updateWeights(pb.weights, samples);

  const bucketRows = outcomeRows.map((r) => ({ clip: r.clip, y: r.perf }));
  const bkts = buckets(bucketRows);
  const findings = bkts.filter((b) => Math.abs(b.meanPerf) >= 0.3 && b.n >= 5).map(findingLine);

  const nPublished = outcomeRows.length;
  const nReviewed = reviewed.length;

  const ownResults: OwnResults = {
    updatedAt: now.toISOString(),
    nPublished,
    nReviewed,
    findings,
    rejectionNotes,
    buckets: bkts,
    signalCorrelations: correlations,
  };

  const weightsChanged = SIGNALS.some((s) => Math.abs(weights[s] - pb.weights[s]) > 1e-9);
  const priorNPublished = pb.ownResults?.nPublished ?? 0;
  const priorNReviewed = pb.ownResults?.nReviewed ?? 0;
  const hasNewData = nPublished !== priorNPublished || nReviewed !== priorNReviewed;

  if (weightsChanged || hasNewData) {
    pb.ownResults = ownResults;
    pb.weights = weights;
    pb.version += 1;
    pb.updatedAt = now.toISOString();
    savePlaybook(pb);
  }

  return ownResults;
}

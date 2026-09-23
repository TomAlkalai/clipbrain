import fs from 'node:fs';
import path from 'node:path';
import { paths, readJsonOr, writeJson } from '../store.js';
import { SIGNALS } from '../types.js';
import type { ShortFeatures, SignalName } from '../types.js';

export type Quartiles = { p25: number; median: number; p75: number };

export type HookPattern = { id: string; name: string; description: string; examples: string[] };
export type Structure = { id: string; name: string; description: string };
export type Exemplar = { shortId: string; title: string; perf: number; why: string };

export type OwnResults = {
  updatedAt: string;
  nPublished: number;
  nReviewed: number;
  findings: string[];
  rejectionNotes: string[];
  buckets: { feature: string; value: string; n: number; meanPerf: number }[];
  signalCorrelations: Partial<Record<SignalName, { rho: number; n: number }>>;
};

export type Playbook = {
  creator: string;
  version: number;
  updatedAt: string;
  source: 'default' | 'mined';
  stats: {
    nShorts: number;
    nAligned: number;
    duration: Quartiles;
    topDuration: Quartiles;
    coldOpenRate: number;
    topColdOpenRate: number;
    tightenedRate: number;
    startsAfterPauseRate: number;
  } | null;
  idealDurationSec: { min: number; max: number };
  principles: string[];
  hookPatterns: HookPattern[];
  structures: Structure[];
  antiPatterns: string[];
  exemplars: Exemplar[];
  weights: Record<SignalName, number>;
  ownResults: OwnResults | null;
};

// Linear-interpolation percentile (numpy/R-7 default): matches median([20,30,35,40,50,60]) === 37.5.
function quantile(sortedAsc: number[], q: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAsc[0];
  const idx = (n - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (idx - lo) * (sortedAsc[hi] - sortedAsc[lo]);
}

export function quartiles(xs: number[]): Quartiles {
  const sorted = [...xs].sort((a, b) => a - b);
  return { p25: quantile(sorted, 0.25), median: quantile(sorted, 0.5), p75: quantile(sorted, 0.75) };
}

function rate(set: ShortFeatures[], pred: (f: ShortFeatures) => boolean): number {
  return set.length === 0 ? 0 : set.filter(pred).length / set.length;
}

// R5: "top tercile" = features with perf >= (perfs sorted ascending)[floor(n*2/3)].
export function computeStats(features: ShortFeatures[]): NonNullable<Playbook['stats']> {
  const n = features.length;
  if (n === 0) {
    const empty = quartiles([]);
    return { nShorts: 0, nAligned: 0, duration: empty, topDuration: empty, coldOpenRate: 0, topColdOpenRate: 0, tightenedRate: 0, startsAfterPauseRate: 0 };
  }
  const perfsSorted = features.map((f) => f.perf).sort((a, b) => a - b);
  const threshold = perfsSorted[Math.floor((n * 2) / 3)];
  const top = features.filter((f) => f.perf >= threshold);
  return {
    nShorts: n,
    nAligned: n,
    duration: quartiles(features.map((f) => f.durationSec)),
    topDuration: quartiles(top.map((f) => f.durationSec)),
    coldOpenRate: rate(features, (f) => f.coldOpen),
    topColdOpenRate: rate(top, (f) => f.coldOpen),
    tightenedRate: rate(features, (f) => f.tightened),
    startsAfterPauseRate: rate(features, (f) => f.startsAfterPause),
  };
}

export function defaultPlaybook(creator: string): Playbook {
  const weights = Object.fromEntries(SIGNALS.map((s) => [s, 1])) as Record<SignalName, number>;
  return {
    creator,
    version: 0,
    updatedAt: new Date().toISOString(),
    source: 'default',
    stats: null,
    idealDurationSec: { min: 20, max: 75 },
    principles: [
      'The first sentence must make sense with zero prior context and create a question or tension within 3 seconds.',
      'One idea per clip: a claim, a story, or a framework — with its payoff included.',
      'End on the payoff or a punchline, never mid-explanation.',
      'Prefer specific numbers, stories and contrarian claims over generic advice.',
      'Cut setup that the viewer does not need; keep setup the payoff depends on.',
    ],
    hookPatterns: [
      { id: 'contrarian', name: 'Contrarian', description: 'Opens by contradicting a widely-held belief or common advice.', examples: [] },
      { id: 'number', name: 'Number', description: 'Opens with a specific, concrete number that promises a payoff.', examples: [] },
      { id: 'story', name: 'Story', description: 'Opens mid-anecdote, dropping the viewer into a moment rather than a setup.', examples: [] },
      { id: 'question', name: 'Question', description: 'Opens with a question the viewer wants answered.', examples: [] },
      { id: 'stakes', name: 'Stakes', description: 'Opens by naming a consequence or cost that creates urgency.', examples: [] },
    ],
    structures: [
      { id: 'claim-proof', name: 'Claim → proof', description: 'State a claim, then back it with evidence, examples or reasoning.' },
      { id: 'story-lesson', name: 'Story → lesson', description: 'Tell a short anecdote, then land the lesson it implies.' },
      { id: 'list', name: 'List', description: 'A numbered or enumerated set of points delivered in sequence.' },
    ],
    antiPatterns: [
      "Starting with 'and', 'so', 'but' or a pronoun that refers to earlier context",
      'Clips that only make sense with the full episode',
      'Ending before the point lands',
    ],
    exemplars: [],
    weights,
    ownResults: null,
  };
}

function playbookJsonPath(slug: string): string {
  return path.join(paths.creator(slug), 'playbook.json');
}
function playbookMdPath(slug: string): string {
  return path.join(paths.creator(slug), 'playbook.md');
}

export function loadPlaybook(slug: string): Playbook {
  return readJsonOr<Playbook>(playbookJsonPath(slug), defaultPlaybook(slug));
}

export function savePlaybook(pb: Playbook): void {
  fs.mkdirSync(paths.creator(pb.creator), { recursive: true });
  writeJson(playbookJsonPath(pb.creator), pb);
  fs.writeFileSync(playbookMdPath(pb.creator), renderPlaybookMd(pb));
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}
function q(qq: Quartiles): string {
  return `p25=${qq.p25.toFixed(1)} median=${qq.median.toFixed(1)} p75=${qq.p75.toFixed(1)}`;
}

export function renderPlaybookMd(pb: Playbook): string {
  const lines: string[] = [];
  lines.push(`# Playbook — ${pb.creator} (v${pb.version})`);
  lines.push('');
  lines.push(`_source: ${pb.source} · updated: ${pb.updatedAt}_`);
  lines.push('');

  lines.push('## Stats');
  if (pb.stats) {
    const s = pb.stats;
    lines.push(`- nShorts: ${s.nShorts}, nAligned: ${s.nAligned}`);
    lines.push(`- duration (s): ${q(s.duration)}`);
    lines.push(`- top-tercile duration (s): ${q(s.topDuration)}`);
    lines.push(`- cold-open rate: ${pct(s.coldOpenRate)} (top tercile: ${pct(s.topColdOpenRate)})`);
    lines.push(`- tightened rate: ${pct(s.tightenedRate)}`);
    lines.push(`- starts-after-pause rate: ${pct(s.startsAfterPauseRate)}`);
  } else {
    lines.push('No mined stats yet — run `playbook <slug> --distill` after mining.');
  }
  lines.push('');

  lines.push('## Ideal duration');
  lines.push(`${pb.idealDurationSec.min}–${pb.idealDurationSec.max} s`);
  lines.push('');

  lines.push('## Principles');
  pb.principles.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
  lines.push('');

  lines.push('## Hook patterns');
  for (const hp of pb.hookPatterns) {
    lines.push(`- **[${hp.id}] ${hp.name}**: ${hp.description}`);
    for (const ex of hp.examples) lines.push(`  - e.g. "${ex}"`);
  }
  lines.push('');

  lines.push('## Structures');
  for (const st of pb.structures) lines.push(`- **[${st.id}] ${st.name}**: ${st.description}`);
  lines.push('');

  lines.push('## Anti-patterns');
  for (const ap of pb.antiPatterns) lines.push(`- ${ap}`);
  lines.push('');

  lines.push('## Exemplars');
  if (pb.exemplars.length === 0) {
    lines.push('None yet.');
  } else {
    for (const ex of pb.exemplars) lines.push(`- [${ex.shortId}] ${ex.title} (perf=${ex.perf.toFixed(2)}) — ${ex.why}`);
  }
  lines.push('');

  lines.push('## Signal weights');
  for (const sig of SIGNALS) lines.push(`- ${sig}: ${pb.weights[sig]}`);
  lines.push('');

  lines.push('## Own results');
  if (pb.ownResults) {
    const or = pb.ownResults;
    lines.push(`_updated: ${or.updatedAt} · published: ${or.nPublished} · reviewed: ${or.nReviewed}_`);
    if (or.findings.length > 0) {
      lines.push('Findings:');
      for (const f of or.findings) lines.push(`- ${f}`);
    }
    if (or.rejectionNotes.length > 0) {
      lines.push('Recent rejection notes:');
      for (const rn of or.rejectionNotes.slice(-10)) lines.push(`- ${rn}`);
    }
  } else {
    lines.push('No own results yet.');
  }

  return lines.join('\n');
}

export function playbookPromptBlock(pb: Playbook): string {
  const lines: string[] = [];
  lines.push(`Playbook for ${pb.creator} (v${pb.version}, ${pb.source}):`);
  lines.push('Principles:');
  pb.principles.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
  lines.push('Hook patterns:');
  for (const hp of pb.hookPatterns) {
    const ex = hp.examples.length > 0 ? ` (e.g. "${hp.examples[0]}")` : '';
    lines.push(`- [${hp.id}] ${hp.name}: ${hp.description}${ex}`);
  }
  lines.push('Structures:');
  for (const st of pb.structures) lines.push(`- [${st.id}] ${st.name}: ${st.description}`);
  lines.push('Anti-patterns:');
  for (const ap of pb.antiPatterns) lines.push(`- ${ap}`);
  lines.push(`Ideal duration: ${pb.idealDurationSec.min}–${pb.idealDurationSec.max} s`);
  if (pb.ownResults) {
    if (pb.ownResults.findings.length > 0) {
      lines.push('Own-results findings:');
      for (const f of pb.ownResults.findings) lines.push(`- ${f}`);
    }
    if (pb.ownResults.rejectionNotes.length > 0) {
      lines.push('Recent rejection notes:');
      for (const rn of pb.ownResults.rejectionNotes.slice(-10)) lines.push(`- ${rn}`);
    }
  }
  return lines.join('\n');
}

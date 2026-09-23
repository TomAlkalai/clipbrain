import path from 'node:path';
import { paths, readJson } from '../store.js';
import { llmJson } from '../llm/llm.js';
import type { ShortFeatures } from '../types.js';
import { computeStats, loadPlaybook, type Playbook, type Exemplar, type HookPattern, type Structure } from './playbook.js';

const MIN_ALIGNED = 8;
const TOP_N = 12;
const BOTTOM_N = 8;
const MIN_DURATION_SEC = 12;
const MAX_DURATION_SEC = 180; // controller ruling: distilled idealDurationSec clamps to 12-180, not 12-120.

const SYSTEM = `You are a senior short-form editor reverse-engineering how a professional clip team cuts long-form podcast episodes into Shorts. You are given measured statistics and paired examples (the short's words, the words just before it in the episode, structural features, and performance relative to the channel median; perf>0 = above median). Infer the editorial rules that separate high performers from low performers. Be concrete and falsifiable; no generic advice that would apply to any channel. Pattern ids must be short kebab-case. Examples must be verbatim opening lines from the provided shorts. Exemplars must reference provided shortIds.`;

const SCHEMA = {
  type: 'object',
  required: ['principles', 'hookPatterns', 'structures', 'antiPatterns', 'exemplars', 'idealDurationSec'],
  properties: {
    principles: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    hookPatterns: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        required: ['id', 'name', 'description', 'examples'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          examples: { type: 'array', items: { type: 'string' }, maxItems: 3 },
        },
      },
    },
    structures: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        required: ['id', 'name', 'description'],
        properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' } },
      },
    },
    antiPatterns: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    exemplars: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        required: ['shortId', 'why'],
        properties: { shortId: { type: 'string' }, why: { type: 'string' } },
      },
    },
    idealDurationSec: { type: 'object', required: ['min', 'max'], properties: { min: { type: 'number' }, max: { type: 'number' } } },
  },
} as const;

type DistillOutput = {
  principles: string[];
  hookPatterns: HookPattern[];
  structures: Structure[];
  antiPatterns: string[];
  exemplars: { shortId: string; why: string }[];
  idealDurationSec: { min: number; max: number };
};

function fmtPerf(x: number): string {
  return `${x >= 0 ? '+' : ''}${x.toFixed(2)}`;
}

function exampleBlock(f: ShortFeatures): string {
  return [
    `### ${f.shortId} perf=${fmtPerf(f.perf)} dur=${Math.round(f.durationSec)}s segments=${f.nSegments} coldOpen=${f.coldOpen} tightened=${f.tightened} startsAfterPause=${f.startsAfterPause} position=${f.positionInEpisode.toFixed(2)}`,
    `TITLE: ${f.title}`,
    `BEFORE: ${f.contextBefore}`,
    `SHORT: ${f.text}`,
  ].join('\n');
}

// Highest-perf 12 and lowest-perf 8 (deduped, since a small feature set can have both
// selections overlap), sorted best-to-worst so the contrast between top and bottom is
// legible to the model reading the prompt top-to-bottom.
function pickExamples(features: ShortFeatures[]): ShortFeatures[] {
  const byPerfDesc = [...features].sort((a, b) => b.perf - a.perf);
  const top = byPerfDesc.slice(0, TOP_N);
  const bottom = byPerfDesc.slice(-BOTTOM_N);
  const seen = new Set<string>();
  const out: ShortFeatures[] = [];
  for (const f of [...top, ...bottom]) {
    if (seen.has(f.shortId)) continue;
    seen.add(f.shortId);
    out.push(f);
  }
  return out;
}

function clampDuration(x: number): number {
  return Math.min(MAX_DURATION_SEC, Math.max(MIN_DURATION_SEC, x));
}

export async function distill(slug: string): Promise<Playbook> {
  const featuresPath = path.join(paths.creator(slug), 'features.json');
  const features = readJson<ShortFeatures[]>(featuresPath);
  if (features.length < MIN_ALIGNED) {
    throw new Error('not enough aligned shorts');
  }

  const old = loadPlaybook(slug);
  const stats = computeStats(features);
  const examples = pickExamples(features);

  const prompt = [JSON.stringify(stats, null, 2), '', ...examples.map(exampleBlock)].join('\n\n');

  const out = await llmJson<DistillOutput>({
    tier: 'balanced',
    purpose: 'distill',
    system: SYSTEM,
    prompt,
    schema: SCHEMA,
  });

  const byId = new Map(features.map((f) => [f.shortId, f]));
  const exemplars: Exemplar[] = [];
  for (const e of out.exemplars) {
    const f = byId.get(e.shortId);
    if (!f) continue; // drop hallucinated shortIds rather than emit a broken exemplar
    exemplars.push({ shortId: e.shortId, title: f.title, perf: f.perf, why: e.why });
  }

  const minD = clampDuration(out.idealDurationSec.min);
  const maxD = clampDuration(out.idealDurationSec.max);

  return {
    creator: slug,
    version: old.version + 1,
    updatedAt: new Date().toISOString(),
    source: 'mined',
    stats,
    idealDurationSec: minD <= maxD ? { min: minD, max: maxD } : { min: maxD, max: minD },
    principles: out.principles,
    hookPatterns: out.hookPatterns,
    structures: out.structures,
    antiPatterns: out.antiPatterns,
    exemplars,
    weights: old.weights,
    ownResults: old.ownResults,
  };
}

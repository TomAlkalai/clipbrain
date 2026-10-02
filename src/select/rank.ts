import { llmJson, type Tier } from '../llm/llm.js';
import { SIGNALS } from '../types.js';
import type { Candidate, Sentence, ShortFeatures } from '../types.js';
import { mmss } from './propose.js';

export type AudienceExample = { title: string; perf: number };

/**
 * The creator's own top `n` official Shorts by performance (perf = ln(views/channel median) —
 * see mine/features.ts), reduced to just {title, perf} for the final-rank prompt: audience
 * proof of what this specific channel's viewers already respond to. Pure.
 */
export function topAudienceExamples(features: ShortFeatures[], n: number): AudienceExample[] {
  return [...features]
    .sort((a, b) => b.perf - a.perf)
    .slice(0, n)
    .map((f) => ({ title: f.title, perf: f.perf }));
}

export const RANK_SCHEMA = {
  type: 'object',
  required: ['ranking'],
  properties: {
    ranking: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'reason'],
        properties: { id: { type: 'string' }, reason: { type: 'string' } },
      },
    },
  },
};

function systemPrompt(creatorName: string, n: number, showScores = true): string {
  const seen = showScores ? 'candidate clips (with per-signal scores from a first-pass editor who may be miscalibrated)' : 'candidate clips';
  return (
    `You pick the final Shorts to produce for ${creatorName}. You see ${seen}. Choose the ${n} best, considering the playbook, variety of topics and ` +
    `hook patterns (do not pick near-duplicates of the same idea), and whether each would make a stranger stop scrolling. ` +
    `You are also given a list of this channel's own official Shorts that performed best with its audience — weigh each ` +
    `candidate's audience fit against those examples (topic, framing, stakes), but do not copy their topics blindly: a ` +
    `candidate on a different subject can still be the right pick if it shares what made those examples resonate. ` +
    `Return them best first with a one-sentence reason.`
  );
}

/** Renders the audience-calibration prompt section, or '' when there are no examples. Pure. */
function audienceBlock(examples: AudienceExample[]): string {
  if (examples.length === 0) return '';
  const lines = examples.map((e) => `- "${e.title}" (perf ${e.perf.toFixed(2)} vs channel median)`).join('\n');
  return `What this channel's audience responded to most (official Shorts, by performance vs channel median):\n${lines}\n\n`;
}

function candidateLine(c: Candidate, sentences: Sentence[], showScores = true): string {
  const dur = Math.round(c.end - c.start);
  const opening = sentences[c.startSid]?.text ?? '';
  const visualLine = c.visual
    ? `\nvisual: ${c.visual.score}/10 — ${c.visual.issues.length ? c.visual.issues.join('; ') : 'none'}`
    : '';
  if (!showScores) {
    return `${c.id} | ${mmss(c.start)}–${mmss(c.end)} (${dur}s) | ${c.title}\n${c.summary}\n${c.why}\nopening sentence: "${opening}"${visualLine}`;
  }
  const scores = SIGNALS.map((s) => `${s} ${c.scores[s].score} (${c.scores[s].reason})`).join(' · ');
  return (
    `${c.id} | ${mmss(c.start)}–${mmss(c.end)} (${dur}s) | ${c.composite} | ${c.title}\n` +
    `${c.summary}\n${c.why}\n` +
    `opening sentence: "${opening}"\n` +
    `scores: ${scores}${visualLine}`
  );
}

/** Ranking-benchmark variants (design §7): V1 hides scores, V3 changes the tier, repeats bypass the cache. */
export type RankOpts = { showScores?: boolean; tier?: Tier; noCache?: boolean };

/** One LLM call (tier `strong`) choosing the best `n` candidates from the shortlist pool. */
export async function finalRank(
  cands: Candidate[],
  sentences: Sentence[],
  creatorName: string,
  pbBlock: string,
  n: number,
  audienceExamples: AudienceExample[] = [],
  o: RankOpts = {},
): Promise<{ id: string; reason: string }[]> {
  if (cands.length === 0) return [];
  const showScores = o.showScores ?? true;
  const prompt =
    `${pbBlock}\n\n${audienceBlock(audienceExamples)}Candidates:\n\n${cands.map((c) => candidateLine(c, sentences, showScores)).join('\n\n')}`;
  const result = await llmJson<{ ranking: { id: string; reason: string }[] }>({
    tier: o.tier ?? 'strong',
    noCache: o.noCache,
    purpose: 'rank',
    system: systemPrompt(creatorName, n, showScores),
    prompt,
    schema: { ...RANK_SCHEMA, properties: { ranking: { ...RANK_SCHEMA.properties.ranking, maxItems: n } } },
  });
  return (result.ranking ?? []).slice(0, n);
}

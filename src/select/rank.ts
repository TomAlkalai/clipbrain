import { llmJson } from '../llm/llm.js';
import { SIGNALS } from '../types.js';
import type { Candidate, Sentence } from '../types.js';
import { mmss } from './propose.js';

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

function systemPrompt(creatorName: string, n: number): string {
  return (
    `You pick the final Shorts to produce for ${creatorName}. You see candidate clips (with per-signal scores from a ` +
    `first-pass editor who may be miscalibrated). Choose the ${n} best, considering the playbook, variety of topics and ` +
    `hook patterns (do not pick near-duplicates of the same idea), and whether each would make a stranger stop scrolling. ` +
    `Return them best first with a one-sentence reason.`
  );
}

function candidateLine(c: Candidate, sentences: Sentence[]): string {
  const dur = Math.round(c.end - c.start);
  const opening = sentences[c.startSid]?.text ?? '';
  const scores = SIGNALS.map((s) => `${s} ${c.scores[s].score} (${c.scores[s].reason})`).join(' · ');
  const visualLine = c.visual
    ? `\nvisual: ${c.visual.score}/10 — ${c.visual.issues.length ? c.visual.issues.join('; ') : 'none'}`
    : '';
  return (
    `${c.id} | ${mmss(c.start)}–${mmss(c.end)} (${dur}s) | ${c.composite} | ${c.title}\n` +
    `${c.summary}\n${c.why}\n` +
    `opening sentence: "${opening}"\n` +
    `scores: ${scores}${visualLine}`
  );
}

/** One LLM call (tier `strong`) choosing the best `n` candidates from the shortlist pool. */
export async function finalRank(
  cands: Candidate[],
  sentences: Sentence[],
  creatorName: string,
  pbBlock: string,
  n: number,
): Promise<{ id: string; reason: string }[]> {
  if (cands.length === 0) return [];
  const prompt = `${pbBlock}\n\nCandidates:\n\n${cands.map((c) => candidateLine(c, sentences)).join('\n\n')}`;
  const result = await llmJson<{ ranking: { id: string; reason: string }[] }>({
    tier: 'strong',
    purpose: 'rank',
    system: systemPrompt(creatorName, n),
    prompt,
    schema: { ...RANK_SCHEMA, properties: { ranking: { ...RANK_SCHEMA.properties.ranking, maxItems: n } } },
  });
  return (result.ranking ?? []).slice(0, n);
}

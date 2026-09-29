import { llmJson } from '../llm/llm.js';
import { SIGNALS } from '../types.js';
import type { Sentence, Candidate } from '../types.js';

export type RawCandidate = Omit<
  Candidate,
  'id' | 'sourceId' | 'start' | 'end' | 'composite' | 'shortlisted' | 'rank' | 'rankReason'
>;

const scoreProp = {
  type: 'object',
  required: ['score', 'reason'],
  properties: { score: { type: 'number', minimum: 0, maximum: 10 }, reason: { type: 'string' } },
};

export const PROPOSE_SCHEMA = {
  type: 'object',
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        required: ['startSid', 'endSid', 'title', 'summary', 'why', 'patterns', 'scores'],
        properties: {
          startSid: { type: 'integer' },
          endSid: { type: 'integer' },
          title: { type: 'string' },
          summary: { type: 'string' },
          why: { type: 'string' },
          patterns: { type: 'array', items: { type: 'string' } },
          scores: { type: 'object', required: SIGNALS, properties: Object.fromEntries(SIGNALS.map((s) => [s, scoreProp])) },
        },
      },
    },
  },
};

/** `123` -> `"2:03"`. Pure. */
export function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

/** Renders a sentence range as `[<id>] (<m:ss>) <text>` lines, one per sentence. Pure. */
export function formatWindow(sentences: Sentence[], s0: number, s1: number): string {
  const lines: string[] = [];
  for (let i = s0; i <= s1; i++) {
    const s = sentences[i];
    lines.push(`[${s.id}] (${mmss(s.start)}) ${s.text}`);
  }
  return lines.join('\n');
}

// NOTE: the brief's ctx type is { creatorName, pbBlock, minSec, maxSec }, but the brief's own
// prompt template starts with "Episode: <title>" — the episode's title has to come from
// somewhere, and it isn't derivable from sentences/window data. Adding `title` here is the
// straightforward reading of that requirement (selectSource has the Source and passes it through).
export type ProposeCtx = { creatorName: string; title: string; pbBlock: string; minSec: number; maxSec: number };

function systemPrompt(ctx: ProposeCtx): string {
  return (
    `You are the head clip editor for ${ctx.creatorName}. From a timestamped transcript window of a long-form episode, ` +
    `find moments that work as standalone vertical Shorts. Follow the channel playbook below — it was learned from this ` +
    `channel's own best and worst performing Shorts.\n\n${ctx.pbBlock}\n\nRules:\n` +
    `- A clip is a contiguous range of sentence ids [startSid, endSid], duration between ${ctx.minSec} and ${ctx.maxSec} seconds (use the timestamps).\n` +
    `- startSid must be understandable with zero prior context. Before you finalize a range, run this check on its first 2-3 sentences: for every ` +
    `pronoun or referring phrase ("that", "this", "it", "he", "she", "they", "this test", "that time", "these X", "the thing I mentioned"...) AND ` +
    `every elliptical count or category ("there are six stages", "the three steps are", "one of the P's") — can you point to the specific word or ` +
    `idea it refers to (what is being counted, what category "the P's" names) using ONLY sentences from startSid onward? If not — the referent or ` +
    `the label for what's being enumerated was only said earlier in the transcript, outside the clip — shift startSid forward past that sentence to ` +
    `the next one that passes the check on its own, even if it costs some setup; a confusing open is worse than a shorter clip. A sentence that ` +
    `merely opens with a connective ("so", "and", "but") passes the check fine as long as everything it refers to is resolvable within the clip itself.\n` +
    `- endSid must land the payoff; include the line where the point hits, not the line before it.\n` +
    `- Return EVERY moment in this window that could plausibly work as a standalone Short (typically 2–6 per 10 minutes ` +
    `of conversation). A later ranking stage filters. Scoring must stay honest and calibrated; do not inflate scores to ` +
    `justify inclusion.\n` +
    `- Score each signal 0–10 with a one-line reason. Calibrate: 5 = an average clip on this channel, 8+ = top 10%, 10 = exceptional. Do not inflate.\n` +
    `- patterns = ids of playbook hook patterns / structures the clip uses.`
  );
}

/** One LLM call proposing 0–10 candidate clips from a single transcript window. */
export async function proposeWindow(
  ctx: ProposeCtx,
  sentences: Sentence[],
  w: { s0: number; s1: number },
): Promise<RawCandidate[]> {
  const prompt = `Episode: ${ctx.title}\nTranscript window (sentence id, timestamp, text):\n${formatWindow(sentences, w.s0, w.s1)}`;
  const result = await llmJson<{ candidates: RawCandidate[] }>({
    tier: 'balanced',
    purpose: 'propose',
    system: systemPrompt(ctx),
    prompt,
    schema: PROPOSE_SCHEMA,
  });
  return result.candidates ?? [];
}

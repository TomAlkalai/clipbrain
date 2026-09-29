import { llmJson } from '../llm/llm.js';
import { playbookPromptBlock } from '../playbook/playbook.js';
import type { Playbook } from '../playbook/playbook.js';
import { mmss } from '../select/propose.js';
import type { Sentence, Hook } from '../types.js';

export const HOOKS_SCHEMA = {
  type: 'object',
  required: ['hooks', 'title', 'description', 'hashtags', 'coldOpenSid', 'coldOpenReason'],
  properties: {
    hooks: {
      type: 'array',
      minItems: 3,
      maxItems: 5,
      items: {
        type: 'object',
        required: ['text', 'pattern', 'score'],
        properties: {
          text: { type: 'string' },
          pattern: { type: 'string' },
          score: { type: 'number', minimum: 0, maximum: 10 },
        },
      },
    },
    title: { type: 'string' },
    description: { type: 'string' },
    hashtags: { type: 'array', maxItems: 5, items: { type: 'string' } },
    coldOpenSid: { type: ['integer', 'null'] },
    coldOpenReason: { type: 'string' },
  },
};

function systemPrompt(creatorName: string, pb: Playbook): string {
  return (
    `You write the on-screen hook text for a vertical Short cut from ${creatorName}'s podcast. The hook is shown in ` +
    `the first ~3 seconds over the video; it must make a scrolling stranger stop, and it must be TRUE to what the ` +
    `clip actually says (no clickbait the clip does not pay off). Max 8 words, no emojis, no hashtags, sentence case. ` +
    `Write 5 hooks using different patterns from the playbook, score each 0–10 honestly for stopping power × accuracy. ` +
    `Also: a YouTube title (≤ 70 chars, may reuse the best hook), a 1–2 sentence description, up to 5 hashtags without ` +
    `'#'. Optionally choose ONE sentence id inside the clip (not the first) that would work as a cold open — a 2–7 s ` +
    `flash-forward of the most gripping line placed before the clip starts; return null if the clip's first line is ` +
    `already the strongest opening.\n\n${playbookPromptBlock(pb)}`
  );
}

/** Renders the clip's sentences as `[id] (m:ss) text` lines, one per sentence. Pure. */
function renderClip(sentences: Sentence[], startSid: number, endSid: number): string {
  const lines: string[] = [];
  for (let i = startSid; i <= endSid; i++) {
    const s = sentences[i];
    lines.push(`[${s.id}] (${mmss(s.start)}) ${s.text}`);
  }
  return lines.join('\n');
}

export type GenerateHooksInput = {
  creatorName: string;
  episodeTitle: string;
  pb: Playbook;
  sentences: Sentence[];
  startSid: number;
  endSid: number;
  candidateTitle: string;
  summary: string;
};

export type GeneratedHooks = {
  hooks: Hook[];
  title: string;
  description: string;
  hashtags: string[];
  coldOpenSid: number | null;
  coldOpenReason: string;
};

/**
 * Validates an LLM-proposed cold-open sentence id, pure: valid only if it is strictly after
 * the clip's start and no later than its end, and the sentence's own duration is a plausible
 * flash-forward length (1.5–7s) — otherwise null.
 */
export function validateColdOpen(sentences: Sentence[], startSid: number, endSid: number, sid: number | null): number | null {
  if (sid === null || !Number.isInteger(sid)) return null;
  if (!(sid > startSid && sid <= endSid)) return null;
  const s = sentences[sid];
  if (!s) return null;
  const dur = s.end - s.start;
  if (dur > 7 || dur < 1.5) return null;
  return sid;
}

/**
 * Sorts hooks by score descending (stable), trimming each hook's text and dropping any that
 * are empty or longer than 70 chars after trimming. Pure.
 */
export function sortHooks(hooks: Hook[]): Hook[] {
  return hooks
    .map((h) => ({ ...h, text: h.text.trim() }))
    .filter((h) => h.text.length > 0 && h.text.length <= 70)
    .sort((a, b) => b.score - a.score);
}

/** One LLM call (tier `balanced`) producing hook variants, title, description, hashtags and an optional cold-open pick. */
export async function generateHooks(input: GenerateHooksInput): Promise<GeneratedHooks> {
  const prompt =
    `Episode: ${input.episodeTitle}\n` +
    `Clip title: ${input.candidateTitle}\n` +
    `Clip summary: ${input.summary}\n` +
    `Clip sentences (id, timestamp, text):\n${renderClip(input.sentences, input.startSid, input.endSid)}`;

  const result = await llmJson<GeneratedHooks>({
    tier: 'balanced',
    purpose: 'hooks',
    system: systemPrompt(input.creatorName, input.pb),
    prompt,
    schema: HOOKS_SCHEMA,
  });

  return {
    ...result,
    hooks: sortHooks(result.hooks ?? []),
    coldOpenSid: validateColdOpen(input.sentences, input.startSid, input.endSid, result.coldOpenSid),
  };
}

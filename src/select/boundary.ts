import { llmJson } from '../llm/llm.js';
import type { Candidate, Sentence, Word, SignalName } from '../types.js';
import { snapBounds, composite, candidateId } from './snap.js';

export type BoundaryCheck = {
  openingStandalone: boolean;
  openingIssue: string;
  newStartSid: number | null;
  endingComplete: boolean;
  endingIssue: string;
  newEndSid: number | null;
};

export const BOUNDARY_SCHEMA = {
  type: 'object',
  required: ['openingStandalone', 'openingIssue', 'newStartSid', 'endingComplete', 'endingIssue', 'newEndSid'],
  properties: {
    openingStandalone: { type: 'boolean' },
    openingIssue: { type: 'string' },
    newStartSid: { type: ['integer', 'null'] },
    endingComplete: { type: 'boolean' },
    endingIssue: { type: 'string' },
    newEndSid: { type: ['integer', 'null'] },
  },
};

const SYSTEM_PROMPT =
  `You are a strict continuity checker for a vertical-Shorts clip cut from a longer transcript. You are shown four ` +
  `groups of sentences, each line "[id] text": the 5 sentences immediately BEFORE the clip, the clip's first 4 ` +
  `sentences, the clip's last 3 sentences, and the 3 sentences immediately AFTER the clip.\n\n` +
  `Answer two independent questions:\n` +
  `1. Opening: can a total stranger understand the clip's first sentence with zero prior context? Watch for a bare ` +
  `pronoun or referring phrase ("that", "this", "it", "he", "she", "they", "that time", "this test") or an elliptical ` +
  `count/category ("there are six stages", "one of the three P's") whose referent is only established in the BEFORE ` +
  `sentences, not inside the clip itself.\n` +
  `2. Ending: does the clip end once its point has fully landed (a complete thought, the payoff stated), rather than ` +
  `stopping one beat before it, or wandering on past it into an unrelated tangent?\n\n` +
  `If the opening fails, look at whether one of the clip's own first-4 sentences, or one of the BEFORE sentences, would ` +
  `make a clean, fully self-contained start on its own — if so return its id as newStartSid, else return null. Apply ` +
  `the same idea to the ending using the clip's last-3 or AFTER sentences and newEndSid. Only ever propose an id that ` +
  `was actually shown to you above.`;

function renderSentences(items: Sentence[]): string {
  return items.length === 0 ? '(none)' : items.map((s) => `[${s.id}] ${s.text}`).join('\n');
}

/** One LLM call (tier `fast`) checking whether a candidate's opening and ending stand alone. */
export async function checkBoundaries(c: Candidate, sentences: Sentence[], o: { minSec: number; maxSec: number }): Promise<BoundaryCheck> {
  const before = sentences.slice(Math.max(0, c.startSid - 5), c.startSid);
  const opening = sentences.slice(c.startSid, Math.min(sentences.length, c.startSid + 4));
  const closing = sentences.slice(Math.max(c.startSid, c.endSid - 2), c.endSid + 1);
  const after = sentences.slice(c.endSid + 1, Math.min(sentences.length, c.endSid + 4));

  const prompt =
    `Target clip duration: ${o.minSec}-${o.maxSec}s.\n\n` +
    `BEFORE the clip:\n${renderSentences(before)}\n\n` +
    `Clip opening (first 4 sentences):\n${renderSentences(opening)}\n\n` +
    `Clip ending (last 3 sentences):\n${renderSentences(closing)}\n\n` +
    `AFTER the clip:\n${renderSentences(after)}`;

  return llmJson<BoundaryCheck>({
    tier: 'fast',
    purpose: 'boundary',
    system: SYSTEM_PROMPT,
    prompt,
    schema: BOUNDARY_SCHEMA,
  });
}

export type BoundaryBounds = { minSec: number; maxSec: number; weights: Record<SignalName, number> };

function durationOk(sentences: Sentence[], words: Word[], startSid: number, endSid: number, bounds: BoundaryBounds): { ok: boolean; start: number; end: number } {
  const snapped = snapBounds(sentences, words, startSid, endSid);
  const dur = snapped.end - snapped.start;
  return { ok: dur >= bounds.minSec * 0.85 && dur <= bounds.maxSec * 1.15, start: snapped.start, end: snapped.end };
}

/**
 * Applies a boundary check's verdict to a candidate: repairs startSid/endSid when a valid,
 * in-bounds-duration repair is offered, otherwise penalizes the relevant score so a
 * still-broken opening/ending doesn't rank well. Pure.
 */
export function applyBoundaryCheck(c: Candidate, check: BoundaryCheck, sentences: Sentence[], words: Word[], bounds: BoundaryBounds): Candidate {
  let startSid = c.startSid;
  let endSid = c.endSid;
  const notes: string[] = [];

  let openingStandalone = check.openingStandalone;
  if (!openingStandalone) {
    const proposed = check.newStartSid;
    const inRange =
      proposed !== null &&
      Number.isInteger(proposed) &&
      proposed >= c.startSid - 5 &&
      proposed <= c.startSid + 3 &&
      proposed >= 0 &&
      proposed <= endSid;
    if (inRange) {
      const { ok, start } = durationOk(sentences, words, proposed as number, endSid, bounds);
      if (ok) {
        startSid = proposed as number;
        openingStandalone = true;
        notes.push(`opening repaired to sid ${startSid} (start=${start.toFixed(2)})`);
      } else {
        notes.push(`opening repair to sid ${proposed} rejected: duration out of bounds`);
      }
    }
  }

  let endingComplete = check.endingComplete;
  if (!endingComplete) {
    const proposed = check.newEndSid;
    const inRange =
      proposed !== null &&
      Number.isInteger(proposed) &&
      proposed >= c.endSid - 3 &&
      proposed <= c.endSid + 4 &&
      proposed < sentences.length &&
      proposed >= startSid;
    if (inRange) {
      const { ok, end } = durationOk(sentences, words, startSid, proposed as number, bounds);
      if (ok) {
        endSid = proposed as number;
        endingComplete = true;
        notes.push(`ending repaired to sid ${endSid} (end=${end.toFixed(2)})`);
      } else {
        notes.push(`ending repair to sid ${proposed} rejected: duration out of bounds`);
      }
    }
  }

  const scores = { ...c.scores };
  if (!openingStandalone) {
    const capped = Math.min(scores.standalone_clarity.score, 3);
    scores.standalone_clarity = { score: capped, reason: `boundary: ${check.openingIssue}` };
    notes.push(`standalone_clarity capped at ${capped}`);
  }
  if (!endingComplete) {
    const capped = Math.min(scores.payoff.score, 4);
    scores.payoff = { score: capped, reason: `boundary: ${check.endingIssue}` };
    notes.push(`payoff capped at ${capped}`);
  }

  const repaired = startSid !== c.startSid || endSid !== c.endSid;
  const { start, end } = repaired ? snapBounds(sentences, words, startSid, endSid) : { start: c.start, end: c.end };

  return {
    ...c,
    id: candidateId(c.sourceId, startSid, endSid),
    startSid,
    endSid,
    start,
    end,
    scores,
    composite: composite(scores, bounds.weights),
    boundary: { openingStandalone, endingComplete, repaired, notes: notes.join('; ') },
  };
}

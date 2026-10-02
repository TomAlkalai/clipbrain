import crypto from 'node:crypto';

// Leakage control for the ranking benchmark (design §6). Official Shorts already reach the prompts
// under test: hook-pattern examples are their verbatim opening lines and the ranker's audience
// examples are their titles. An episode is therefore only ever scored with a playbook and audience
// examples built from Shorts of OTHER folds, and every prompt is checked before it is sent.

/** Deterministic fold of an episode: sha1(episodeId) mod k — stable across runs and machines. */
export function foldOf(episodeId: string, k = 3): number {
  return parseInt(crypto.createHash('sha1').update(episodeId).digest('hex').slice(0, 8), 16) % k;
}

/** Items (features, alignments, …) whose episode is NOT in `fold` — what fold `fold` may learn from. */
export function outOfFold<T extends { episodeId: string }>(items: T[], fold: number, k = 3): T[] {
  return items.filter((x) => foldOf(x.episodeId, k) !== fold);
}

export type HeldOutShort = { shortId: string; title: string; text: string };
export type Leak = { shortId: string; kind: 'title' | 'opening' };

const MIN_TITLE_WORDS = 4; // shorter titles ("Wow") are too common to be evidence of a leak
const OPENING_WORDS = 12;
const MIN_OPENING_WORDS = 6;

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Held-out Shorts whose title or opening line (first 12 words) appears in `prompt`. */
export function findLeaks(prompt: string, heldOut: HeldOutShort[]): Leak[] {
  const p = ` ${normalize(prompt)} `;
  const leaks: Leak[] = [];
  for (const s of heldOut) {
    const title = normalize(s.title);
    if (title.split(' ').length >= MIN_TITLE_WORDS && p.includes(` ${title} `)) {
      leaks.push({ shortId: s.shortId, kind: 'title' });
      continue;
    }
    const opening = normalize(s.text).split(' ').slice(0, OPENING_WORDS).join(' ');
    if (opening.split(' ').length >= MIN_OPENING_WORDS && p.includes(` ${opening} `)) {
      leaks.push({ shortId: s.shortId, kind: 'opening' });
    }
  }
  return leaks;
}

/** Throws if `prompt` contains any held-out Short's title or opening line. */
export function assertNoLeak(prompt: string, heldOut: HeldOutShort[], where: string): void {
  const leaks = findLeaks(prompt, heldOut);
  if (leaks.length > 0) {
    throw new Error(`benchmark leakage in ${where}: ${leaks.map((l) => `${l.shortId} (${l.kind})`).join(', ')} — a held-out episode's own Shorts reached its prompt`);
  }
}

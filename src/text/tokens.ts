import type { Word } from '../types.js';

export function normalizeToken(w: string): string {
  return w.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]/g, '');
}

export type Tok = { tok: string; start: number; end: number };

export function tokenize(words: Word[]): Tok[] {
  const out: Tok[] = [];
  for (const word of words) {
    const parts = word.w.split(/\s+/).filter((p) => p.length > 0);
    if (parts.length === 0) continue;
    const span = (word.end - word.start) / parts.length;
    for (let i = 0; i < parts.length; i++) {
      const tok = normalizeToken(parts[i]);
      if (tok === '') continue;
      out.push({ tok, start: word.start + span * i, end: word.start + span * (i + 1) });
    }
  }
  return out;
}

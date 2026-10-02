import { it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
process.env.CB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-rank-'));
const { setBackend } = await import('../src/llm/llm.js');
const { finalRank } = await import('../src/select/rank.js');
const { SIGNALS } = await import('../src/types.js');
import type { Candidate, Sentence } from '../src/types.js';

const scores = Object.fromEntries(SIGNALS.map((s) => [s, { score: 5, reason: 'r' }])) as Candidate['scores'];
const cand = (id: string): Candidate => ({
  id, sourceId: 'src_x', startSid: 0, endSid: 0, start: 0, end: 60, title: id, summary: 's', why: 'w',
  patterns: [], scores, composite: 5, shortlisted: false,
});
const sentences: Sentence[] = [{ id: 0, text: 'Opening line.', start: 0, end: 3, w0: 0, w1: 1 }];

// Review finding: finalRank took the model's list as-is, so a typo'd/hallucinated or repeated id
// silently used up a shortlist slot (fewer clips produced, gaps in the ranks).
it('finalRank drops unknown and repeated ids before taking the top n', async () => {
  setBackend(async () => ({
    output: { ranking: [
      { id: 'cand_b', reason: 'best' },
      { id: 'cand_typo', reason: 'hallucinated' },
      { id: 'cand_b', reason: 'repeat' },
      { id: 'cand_a', reason: 'second' },
      { id: 'cand_c', reason: 'third' },
    ] },
    costUsd: 0,
  }));
  const r = await finalRank([cand('cand_a'), cand('cand_b'), cand('cand_c')], sentences, 'Creator', 'pb', 2);
  expect(r).toEqual([{ id: 'cand_b', reason: 'best' }, { id: 'cand_a', reason: 'second' }]);
});

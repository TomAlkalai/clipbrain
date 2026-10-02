import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// selectSource end to end with fake LLM/vision backends: proposal -> range validation -> snapping
// -> duration filter -> dedupe -> boundary check/repair -> visual (no scan data, no proxy: the
// keyframe step fails and is tolerated) -> final rank -> candidates.json. Pins the wiring the
// ledger flagged as untested (T18) and guards the buildPool extraction used by the benchmark.
process.env.CB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-select-flow-'));
const { setBackend } = await import('../src/llm/llm.js');
const { setVisionBackend } = await import('../src/llm/vision.js');
const { selectSource } = await import('../src/select/select.js');
const { candidateId } = await import('../src/select/snap.js');
const { saveSource, saveCreator, paths, writeJson, readJson } = await import('../src/store.js');
const { SIGNALS } = await import('../src/types.js');
import type { Candidate } from '../src/types.js';

const SRC = 'src_flow0001';
// 60 sentences of 10 s, 4 words each; the default playbook allows 20–75 s clips.
const words = Array.from({ length: 60 }, (_, i) => {
  const s = i * 10;
  return [
    { w: 'Real', start: s, end: s + 1 }, { w: 'mid', start: s + 1.2, end: s + 3 },
    { w: 'more', start: s + 3.2, end: s + 6 }, { w: 'end.', start: s + 6.2, end: s + 9.5 },
  ];
}).flat();
const sentences = Array.from({ length: 60 }, (_, i) => ({ id: i, text: `Sentence ${i} end.`, start: i * 10, end: i * 10 + 9.5, w0: i * 4, w1: i * 4 + 3 }));
const sc = (v: number) => Object.fromEntries(SIGNALS.map((k) => [k, { score: v, reason: 'r' }]));
const raw = (startSid: number, endSid: number, v: number) => ({ startSid, endSid, title: `t${startSid}`, summary: 's', why: 'w', patterns: ['story'], scores: sc(v) });

it('selectSource wires proposal → snap → dedupe → boundary repair → visual → rank → candidates.json', async () => {
  saveCreator({ slug: 'flow', name: 'Flow Creator', channelUrl: 'x', referenceShortsUrls: [], clippingPermission: 'ok', createdAt: '2026-01-01T00:00:00Z' });
  saveSource({ id: SRC, creator: 'flow', kind: 'file', filePath: '/nope.mp4', title: 'Ep', durationSec: 600, width: 1920, height: 1080, createdAt: '2026-01-01T00:00:00Z' });
  writeJson(path.join(paths.source(SRC), 'sentences.json'), sentences);
  writeJson(path.join(paths.source(SRC), 'words.json'), words);

  const calls: Record<string, number> = {};
  setVisionBackend(async () => { throw new Error('vision should not be reached without keyframes'); });
  setBackend(async ({ model, prompt }) => {
    calls[model] = (calls[model] ?? 0) + 1;
    if (model === 'sonnet') {
      return { output: { candidates: [
        raw(3, 6, 8),    // A: ~40 s
        raw(4, 7, 6),    // overlaps A (IoU ~0.6), lower composite → deduped away
        raw(20, 20, 9),  // ~10 s → too short
        raw(30, 35, 7),  // D: ~60 s; the boundary check moves its start to sid 29
        raw(45, 50, 5),  // F: ~60 s
        raw(70, 72, 9),  // outside the window
        raw(12, 11, 9),  // endSid < startSid
      ] }, costUsd: 0 };
    }
    if (model === 'haiku') {
      const repairD = prompt.includes('[30] Sentence 30 end.') && prompt.includes('Clip opening (first 4 sentences):\n[30]');
      return { output: repairD
        ? { openingStandalone: false, openingIssue: 'refers back', newStartSid: 29, endingComplete: true, endingIssue: '', newEndSid: null }
        : { openingStandalone: true, openingIssue: '', newStartSid: null, endingComplete: true, endingIssue: '', newEndSid: null }, costUsd: 0 };
    }
    // opus: rank the pool in reverse of the order it was listed.
    const ids = [...prompt.matchAll(/^(cand_[a-z0-9]{8}) \|/gm)].map((m) => m[1]);
    return { output: { ranking: ids.reverse().map((id) => ({ id, reason: `why ${id}` })) }, costUsd: 0 };
  });

  const out: Candidate[] = await selectSource(SRC, { top: 2 });

  const idA = candidateId(SRC, 3, 6);
  const idD = candidateId(SRC, 29, 35);
  const idF = candidateId(SRC, 45, 50);
  expect(out.map((c) => c.id)).toEqual([idF, idD, idA]);
  expect(out.map((c) => [c.rank, c.shortlisted])).toEqual([[1, true], [2, true], [undefined, false]]);
  expect(out.find((c) => c.id === idD)).toMatchObject({ startSid: 29, endSid: 35, boundary: { repaired: true, openingStandalone: true } });
  expect(out.find((c) => c.id === idA)).toMatchObject({ composite: 8 });
  expect(out.find((c) => c.id === idA)!.start).toBeCloseTo(29.88);
  expect(out.find((c) => c.id === idA)!.end).toBeCloseTo(69.8);
  expect(out.every((c) => c.visual && c.visual.score === 6)).toBe(true); // no scan data: -3 coverage, -1 small faces
  expect(out[0].rankReason).toBe(`why ${idF}`);
  expect(calls).toEqual({ sonnet: 1, haiku: 3, opus: 1 });
  expect(readJson<Candidate[]>(path.join(paths.source(SRC), 'candidates.json'))).toEqual(out);
});

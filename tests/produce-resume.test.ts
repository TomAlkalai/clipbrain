import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// produce resume (2026-09-26): produceSource used to skip ANY candidate that already had a clip,
// regardless of status — so a clip stuck at `planned`/`rendered` (e.g. because the process died
// mid-render, or ensureHires threw) could never be finished by a later `produce` call. Isolated in
// its own file (like tests/qc-degrade.test.ts) because it needs CB_DATA redirected to a scratch
// dir *before* config.ts/store.ts are first imported, and needs real fs I/O (store.ts) even
// though the slow pipeline stages themselves (ensureHires/rebuildEdl/renderClip/qcClip/
// generateHooks) are stubbed via dependency injection.
process.env.CB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-produce-resume-'));

const { produceSource, requalifyClip, requalifySource } = await import('../src/produce.js');
const { saveCreator, saveSource, saveClip, loadClip, paths, writeJson, listClips } = await import('../src/store.js');
const { SIGNALS } = await import('../src/types.js');
import type { Clip, Creator, Source, Candidate, Sentence, Scores, ClipStatus } from '../src/types.js';
import type { GeneratedHooks } from '../src/hooks/hooks.js';

const creator: Creator = {
  slug: 'resume-creator',
  name: 'Resume Creator',
  channelUrl: 'https://www.youtube.com/@resume',
  referenceShortsUrls: [],
  clippingPermission: 'ok to clip',
  createdAt: new Date().toISOString(),
};

// Every test gets its OWN unique source id (all tests in this file share one real CB_DATA dir,
// and produceSource/requalifySource both query "every clip of this sourceId" — reusing one source
// id across tests would let one test's leftover clips leak into another's query).
let sourceSeq = 0;
function makeSource(): Source {
  sourceSeq += 1;
  const id = `src_resume${String(sourceSeq).padStart(2, '0')}`;
  return {
    id,
    creator: creator.slug,
    kind: 'youtube',
    url: `https://www.youtube.com/watch?v=${id}`,
    videoId: id,
    title: 'Resume Test Episode',
    durationSec: 3600,
    width: 1920,
    height: 1080,
    createdAt: new Date().toISOString(),
  };
}

const scores: Scores = Object.fromEntries(SIGNALS.map((s) => [s, { score: 7, reason: 'x' }])) as Scores;

function candidate(source: Source, id: string, rank: number): Candidate {
  return {
    id,
    sourceId: source.id,
    startSid: rank * 2,
    endSid: rank * 2 + 1,
    start: rank * 100,
    end: rank * 100 + 40,
    title: `candidate ${id}`,
    summary: 'summary',
    why: 'why',
    patterns: ['contrarian'],
    scores,
    composite: 7,
    rank,
    rankReason: 'top',
    shortlisted: true,
  };
}

const sentences: Sentence[] = Array.from({ length: 20 }, (_, i) => ({ id: i, text: `s${i}`, start: i * 10, end: i * 10 + 3, w0: i * 2, w1: i * 2 + 1 }));

function setSourceFixtures(source: Source, candidates: Candidate[]): void {
  saveCreator(creator);
  saveSource(source);
  const dir = paths.source(source.id);
  writeJson(path.join(dir, 'sentences.json'), sentences);
  writeJson(path.join(dir, 'candidates.json'), candidates);
}

function baseClip(source: Source, overrides: Partial<Clip>): Clip {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? 'clip_placeholder',
    sourceId: source.id,
    creator: creator.slug,
    candidateId: overrides.candidateId ?? 'cand_x',
    start: 0,
    end: 40,
    coldOpen: null,
    title: 't',
    description: 'd',
    hashtags: [],
    hooks: [{ text: 'Hook', pattern: 'p', score: 8 }],
    hookIndex: 0,
    scores,
    composite: 7,
    rankReason: 'top',
    patterns: [],
    hiresOffset: 0,
    status: 'planned',
    renders: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const gen: GeneratedHooks = {
  hooks: [{ text: 'Stub hook', pattern: 'contrarian', score: 9 }],
  title: 'Stub title',
  description: 'Stub description.',
  hashtags: ['stub'],
  coldOpenSid: null,
  coldOpenReason: 'n/a',
};

/** Records every stage call (name + clip id, where applicable) instead of doing real I/O. */
function makeStubs() {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      generateHooks: async () => {
        calls.push('generateHooks');
        return gen;
      },
      ensureHires: async () => {
        calls.push('ensureHires');
      },
      rebuildEdl: async () => {
        calls.push('rebuildEdl');
      },
      renderClip: async (clipId: string) => {
        calls.push(`renderClip:${clipId}`);
      },
      qcClip: async (clipId: string) => {
        calls.push(`qcClip:${clipId}`);
        return { ok: true, checks: [], fixesApplied: [], at: new Date().toISOString() };
      },
    },
  };
}

it('produceSource resumes a `planned` clip (with a stale error) from ensureHires onward, clearing the error', async () => {
  const source = makeSource();
  const cand = candidate(source, 'cand_planned', 1);
  setSourceFixtures(source, [cand]);
  const existing = baseClip(source, { id: 'clip_planned1', candidateId: cand.id, status: 'planned', error: 'boom from a prior crash' });
  saveClip(existing);

  const { calls, deps } = makeStubs();
  const results = await produceSource(source.id, { deps });

  expect(calls).toEqual(['ensureHires', 'rebuildEdl', 'renderClip:clip_planned1', 'qcClip:clip_planned1']);
  expect(results).toHaveLength(1);
  expect(results[0].id).toBe('clip_planned1');
  expect(results[0].error).toBeUndefined();
  expect(loadClip('clip_planned1').error).toBeUndefined();
});

it('produceSource resumes a `rendered` clip with QC only (no ensureHires/rebuildEdl/renderClip, no hook regeneration)', async () => {
  const source = makeSource();
  const cand = candidate(source, 'cand_rendered', 1);
  setSourceFixtures(source, [cand]);
  saveClip(baseClip(source, { id: 'clip_rendered1', candidateId: cand.id, status: 'rendered' }));

  const { calls, deps } = makeStubs();
  const results = await produceSource(source.id, { deps });

  expect(calls).toEqual(['qcClip:clip_rendered1']);
  expect(results).toHaveLength(1);
  expect(results[0].id).toBe('clip_rendered1');
});

it.each(['ready', 'qc_failed', 'approved', 'rejected', 'published'] as ClipStatus[])(
  'produceSource skips a clip whose status is terminal (%s) — no stage is called',
  async (status) => {
    const source = makeSource();
    const cand = candidate(source, `cand_${status}`, 1);
    setSourceFixtures(source, [cand]);
    saveClip(baseClip(source, { id: `clip_${status}`, candidateId: cand.id, status }));

    const { calls, deps } = makeStubs();
    const results = await produceSource(source.id, { deps });

    expect(calls).toEqual([]);
    expect(results).toEqual([]);
  },
);

it('produceSource runs the full pipeline for a brand-new candidate (no existing clip)', async () => {
  const source = makeSource();
  const cand = candidate(source, 'cand_new', 1);
  setSourceFixtures(source, [cand]);

  const { calls, deps } = makeStubs();
  const results = await produceSource(source.id, { deps });

  expect(calls[0]).toBe('generateHooks');
  expect(calls).toEqual(
    expect.arrayContaining(['generateHooks', 'ensureHires', 'rebuildEdl']),
  );
  expect(calls.some((c) => c.startsWith('renderClip:'))).toBe(true);
  expect(calls.some((c) => c.startsWith('qcClip:'))).toBe(true);
  expect(results).toHaveLength(1);
  expect(results[0].candidateId).toBe(cand.id);
  expect(results[0].hooks).toEqual(gen.hooks);
});

it('produceSource surfaces a candidate whose hook generation failed, with the error, WITHOUT persisting any clip', async () => {
  const source = makeSource();
  const cand = candidate(source, 'cand_hookfail', 1);
  setSourceFixtures(source, [cand]);

  const { deps } = makeStubs();
  const failingDeps = { ...deps, generateHooks: async () => { throw new Error('LLM backend down'); } };
  const results = await produceSource(source.id, { deps: failingDeps });

  expect(results).toHaveLength(1);
  expect(results[0].candidateId).toBe(cand.id);
  expect(results[0].error).toContain('LLM backend down');
  // nothing was ever saved to disk for this candidate
  expect(listClips((c) => c.candidateId === cand.id)).toEqual([]);
});

it('produceSource: o.limit counts a resumed candidate the same as a freshly-created one', async () => {
  const source = makeSource();
  const candA = candidate(source, 'cand_a', 1); // resumable (rendered)
  const candB = candidate(source, 'cand_b', 2); // brand-new
  setSourceFixtures(source, [candA, candB]);
  saveClip(baseClip(source, { id: 'clip_a', candidateId: candA.id, status: 'rendered' }));

  const { calls, deps } = makeStubs();
  const results = await produceSource(source.id, { limit: 1, deps });

  expect(results).toHaveLength(1);
  expect(results[0].id).toBe('clip_a');
  expect(calls).toEqual(['qcClip:clip_a']); // candB never touched — generateHooks not called
});

it('requalifyClip rebuilds the EDL and re-runs render+QC only (no ensureHires, no hook regeneration), clearing a stale error', async () => {
  const source = makeSource();
  const cand = candidate(source, 'cand_req', 1);
  setSourceFixtures(source, [cand]);
  saveClip(baseClip(source, { id: 'clip_req1', candidateId: cand.id, status: 'qc_failed', error: 'stale' }));

  const { calls, deps } = makeStubs();
  const result = await requalifyClip('clip_req1', deps);

  expect(calls).toEqual(['rebuildEdl', 'renderClip:clip_req1', 'qcClip:clip_req1']);
  expect(result.error).toBeUndefined();
});

it('requalifySource requalifies every clip of a source in the given status, and only those', async () => {
  const source = makeSource();
  const cand1 = candidate(source, 'cand_r1', 1);
  const cand2 = candidate(source, 'cand_r2', 2);
  const cand3 = candidate(source, 'cand_r3', 3);
  setSourceFixtures(source, [cand1, cand2, cand3]);
  saveClip(baseClip(source, { id: 'clip_r1', candidateId: cand1.id, status: 'qc_failed' }));
  saveClip(baseClip(source, { id: 'clip_r2', candidateId: cand2.id, status: 'qc_failed' }));
  saveClip(baseClip(source, { id: 'clip_r3', candidateId: cand3.id, status: 'ready' })); // different status — untouched

  const { calls, deps } = makeStubs();
  const results = await requalifySource(source.id, 'qc_failed', deps);

  expect(results.map((c) => c.id).sort()).toEqual(['clip_r1', 'clip_r2']);
  expect(calls.filter((c) => c.startsWith('renderClip:')).sort()).toEqual(['renderClip:clip_r1', 'renderClip:clip_r2']);
});

it('requalifySource surfaces a per-clip error and continues to the next clip', async () => {
  const source = makeSource();
  const cand1 = candidate(source, 'cand_e1', 1);
  const cand2 = candidate(source, 'cand_e2', 2);
  setSourceFixtures(source, [cand1, cand2]);
  saveClip(baseClip(source, { id: 'clip_e1', candidateId: cand1.id, status: 'qc_failed' }));
  saveClip(baseClip(source, { id: 'clip_e2', candidateId: cand2.id, status: 'qc_failed' }));

  const { deps } = makeStubs();
  const failingDeps = {
    ...deps,
    renderClip: async (clipId: string) => {
      if (clipId === 'clip_e1') throw new Error('render exploded');
    },
  };
  const results = await requalifySource(source.id, 'qc_failed', failingDeps);

  const r1 = results.find((c) => c.id === 'clip_e1')!;
  const r2 = results.find((c) => c.id === 'clip_e2')!;
  expect(r1.error).toContain('render exploded');
  expect(r2.error).toBeUndefined();
});

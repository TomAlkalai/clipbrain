import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fix round 1 (coordinator review, 2026-09-26): applyFixPlan used to mutate `clip` directly and
// let rebuildEdl persist the new EDL/qcFixHistory/style/etc BEFORE renderClip ran — so if
// renderClip (or rebuildEdl itself) threw, the on-disk clip was left claiming a fix history and a
// new EDL that render.mp4 doesn't actually match (stale/corrupt render, no error recorded).
// Isolated in its own file (like tests/qc-degrade.test.ts / tests/produce-resume.test.ts) because
// it needs CB_DATA redirected to a scratch dir before config.ts/store.ts are first imported.
process.env.CB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-qc-rollback-'));

const { applyFixPlan } = await import('../src/qc/qc.js');
const { saveClip, loadClip } = await import('../src/store.js');
const { SIGNALS } = await import('../src/types.js');
import type { Clip, Edl, Scores } from '../src/types.js';
import type { FixPlan } from '../src/qc/rules.js';
import type { ApplyFixDeps } from '../src/qc/qc.js';

const scores: Scores = Object.fromEntries(SIGNALS.map((s) => [s, { score: 5, reason: 'x' }])) as Scores;

function fakeClip(id: string, overrides: Partial<Clip> = {}): Clip {
  const edl: Edl = {
    fps: 30,
    width: 1080,
    height: 1920,
    videoSrc: 'hires.mp4',
    srcAspect: 16 / 9,
    segments: [{ srcStart: 0, srcEnd: 1, layout: { kind: 'face', cx: 0.5, cy: 0.5, zoom: 1 } }],
    captions: [],
    hook: null,
    durationSec: 40,
    style: 'default',
  };
  const now = new Date().toISOString();
  return {
    id,
    sourceId: 'src_test',
    creator: 'test',
    candidateId: 'cand_test',
    start: 0,
    end: 40,
    coldOpen: null,
    title: 't',
    description: '',
    hashtags: [],
    hooks: [{ text: 'Hook A', pattern: 'p', score: 8 }],
    hookIndex: 0,
    scores,
    composite: 0,
    rankReason: '',
    patterns: [],
    hiresOffset: 0,
    style: 'default',
    edl,
    status: 'rendered',
    renders: 1,
    createdAt: now,
    updatedAt: now,
    qcFixHistory: [],
    ...overrides,
  };
}

// A rebuildEdl stub that mimics the REAL rebuildEdl's contract: mutates the working copy's `edl`
// and persists it immediately via saveClip — exactly the premature-persistence step whose effects
// must be undone if the render that follows then fails.
function fakeRebuildEdlPersisting(newDurationSec: number) {
  return async (working: Clip): Promise<void> => {
    working.edl = { ...working.edl!, durationSec: newDurationSec };
    saveClip(working);
  };
}

it('restores the previous on-disk clip (EDL/qcFixHistory/style/etc) and records .error when renderClip fails after rebuildEdl already persisted', async () => {
  const clip = fakeClip('clip_rollback1', { style: 'default', hookIndex: 0, qcFixHistory: [] });
  saveClip(clip);

  const plans: FixPlan[] = [{ kind: 'move_hook_up', reason: 'test' }];
  const deps: ApplyFixDeps = {
    rebuildEdl: fakeRebuildEdlPersisting(999),
    renderClip: async () => {
      throw new Error('ffmpeg exploded');
    },
    master: async () => {},
  };

  const result = await applyFixPlan(plans, clip, deps);

  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain('ffmpeg exploded');

  const onDisk = loadClip('clip_rollback1');
  expect(onDisk.style).toBe('default'); // reverted — NOT 'hook-high'
  expect(onDisk.qcFixHistory).toEqual([]); // reverted — NOT ['move_hook_up']
  expect(onDisk.edl?.durationSec).toBe(40); // reverted — NOT 999 (what rebuildEdl had already persisted)
  expect(onDisk.error).toContain('ffmpeg exploded');
});

it('restores the previous on-disk clip when rebuildEdl itself throws (before any render is attempted)', async () => {
  const clip = fakeClip('clip_rollback2', { start: 0, end: 40, qcFixHistory: [] });
  saveClip(clip);

  const plans: FixPlan[] = [{ kind: 'extend_end', newEnd: 50, reason: 'test' }];
  let renderCalled = false;
  const deps: ApplyFixDeps = {
    rebuildEdl: async () => {
      throw new Error('hires fetch failed');
    },
    renderClip: async () => {
      renderCalled = true;
    },
    master: async () => {},
  };

  const result = await applyFixPlan(plans, clip, deps);

  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain('hires fetch failed');
  expect(renderCalled).toBe(false); // never got that far
  const onDisk = loadClip('clip_rollback2');
  expect(onDisk.end).toBe(40); // reverted — NOT 50
  expect(onDisk.error).toContain('hires fetch failed');
});

it('persists the new state (EDL + qcFixHistory + style) only after a successful render', async () => {
  const clip = fakeClip('clip_rollback3', { style: 'default', qcFixHistory: [] });
  saveClip(clip);

  const plans: FixPlan[] = [{ kind: 'move_hook_up', reason: 'test' }];
  const deps: ApplyFixDeps = {
    rebuildEdl: fakeRebuildEdlPersisting(123),
    renderClip: async () => {},
    master: async () => {},
  };

  const result = await applyFixPlan(plans, clip, deps);

  expect(result.ok).toBe(true);
  const onDisk = loadClip('clip_rollback3');
  expect(onDisk.style).toBe('hook-high');
  expect(onDisk.qcFixHistory).toEqual(['move_hook_up']);
  expect(onDisk.edl?.durationSec).toBe(123);
  expect(onDisk.error).toBeUndefined();
});

it('a remaster-only failure also restores + records .error, without attempting rebuildEdl/renderClip at all', async () => {
  const clip = fakeClip('clip_rollback4', { qcFixHistory: [] });
  saveClip(clip);

  const plans: FixPlan[] = [{ kind: 'remaster', reason: 'loudness/true_peak out of spec' }];
  let rebuildCalled = false;
  let renderCalled = false;
  const deps: ApplyFixDeps = {
    rebuildEdl: async () => {
      rebuildCalled = true;
    },
    renderClip: async () => {
      renderCalled = true;
    },
    master: async () => {
      throw new Error('loudnorm encode failed');
    },
  };

  const result = await applyFixPlan(plans, clip, deps);

  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain('loudnorm encode failed');
  expect(rebuildCalled).toBe(false);
  expect(renderCalled).toBe(false);
  const onDisk = loadClip('clip_rollback4');
  expect(onDisk.error).toContain('loudnorm encode failed');
  expect(onDisk.qcFixHistory).toEqual([]); // never recorded — the fix never actually applied
});

it('a remaster-only success records qcFixHistory without touching rebuildEdl/renderClip', async () => {
  const clip = fakeClip('clip_rollback5', { qcFixHistory: [] });
  saveClip(clip);

  const plans: FixPlan[] = [{ kind: 'remaster', reason: 'loudness/true_peak out of spec' }];
  let rebuildCalled = false;
  let renderCalled = false;
  const deps: ApplyFixDeps = {
    rebuildEdl: async () => {
      rebuildCalled = true;
    },
    renderClip: async () => {
      renderCalled = true;
    },
    master: async () => {},
  };

  const result = await applyFixPlan(plans, clip, deps);

  expect(result.ok).toBe(true);
  expect(rebuildCalled).toBe(false);
  expect(renderCalled).toBe(false);
  const onDisk = loadClip('clip_rollback5');
  expect(onDisk.qcFixHistory).toEqual(['remaster']);
  expect(onDisk.error).toBeUndefined();
});

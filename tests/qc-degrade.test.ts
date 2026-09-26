import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fix round 1, item 3 (controller ruling): a qc-content or qc-vision LLM failure must degrade
// (content: null / vision omitted + a warn-severity `critique_unavailable` check) instead of
// crashing qcClip(). Isolated in its own file (unlike tests/qc.test.ts, which only imports pure
// rules.ts) because it needs CB_DATA redirected to a scratch dir *before* config.ts/store.ts are
// first imported — same pattern as tests/store.test.ts / tests/llm.test.ts.
process.env.CB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-qc-degrade-'));

const { measureContentSafe, critiqueRenderSafe, callVisionCritique } = await import('../src/qc/qc.js');
const { setBackend } = await import('../src/llm/llm.js');
const { setVisionBackend } = await import('../src/llm/vision.js');
const { paths } = await import('../src/store.js');
const { ffmpeg } = await import('../src/tools/bins.js');
const { runOk } = await import('../src/tools/proc.js');
const { SIGNALS } = await import('../src/types.js');
import type { Clip, Edl, Scores } from '../src/types.js';

function fakeClip(overrides: Partial<Clip> = {}): Clip {
  const edl: Edl = {
    fps: 30,
    width: 1080,
    height: 1920,
    videoSrc: 'hires.mp4',
    srcAspect: 16 / 9,
    segments: [{ srcStart: 0, srcEnd: 1, layout: { kind: 'fit' } }],
    captions: [{ start: 0, end: 1, words: [{ w: 'hello', start: 0, end: 0.4 }, { w: 'world.', start: 0.4, end: 1 }] }],
    hook: { text: 'Test hook', start: 0, end: 1 },
    durationSec: 1,
    style: 'default',
  };
  const scores = Object.fromEntries(SIGNALS.map((s) => [s, { score: 5, reason: 'x' }])) as Scores;
  return {
    id: 'clip_degradetest',
    sourceId: 'src_test',
    creator: 'test',
    candidateId: 'cand_test',
    start: 0,
    end: 1,
    coldOpen: null,
    title: 't',
    description: '',
    hashtags: [],
    hooks: [{ text: 'Test hook', pattern: 'p', score: 0 }],
    hookIndex: 0,
    scores,
    composite: 0,
    rankReason: '',
    patterns: [],
    hiresOffset: 0,
    edl,
    status: 'rendered',
    renders: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---- qc-content ----

it('measureContentSafe degrades to content=null + error when the qc-content backend throws (after llmJson\'s own retry)', async () => {
  setBackend(async () => {
    throw new Error('content backend down');
  });
  const result = await measureContentSafe(fakeClip({ id: 'clip_content_fail' }));
  expect(result.content).toBeNull();
  expect(result.error).toContain('content backend down');
});

it('measureContentSafe returns content (no error) when the backend succeeds', async () => {
  setBackend(async () => ({
    output: { standalone: true, cleanEnding: true, hookMatches: true, issues: [] },
    costUsd: 0,
  }));
  const result = await measureContentSafe(fakeClip({ id: 'clip_content_ok' }));
  expect(result.content).toEqual({ standalone: true, cleanEnding: true, hookMatches: true, issues: [] });
  expect(result.error).toBeUndefined();
});

// ---- qc-vision ----

it('callVisionCritique (the LLM-calling half of critiqueRender) propagates when the qc-vision backend throws', async () => {
  setVisionBackend(async () => {
    throw new Error('vision backend down');
  });
  const stillPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-qc-still-')), 'still.jpg');
  fs.writeFileSync(stillPath, Buffer.from([0xff, 0xd8, 0xff])); // llmVisionJson only sha1-hashes bytes; content doesn't need to be a real JPEG
  await expect(callVisionCritique(fakeClip({ id: 'clip_vision_fail' }), [stillPath])).rejects.toThrow(/vision backend down/);
});

it('critiqueRenderSafe degrades to vision=null + error (real still-extraction, stubbed LLM call)', async () => {
  setVisionBackend(async () => {
    throw new Error('vision backend down again');
  });
  const clip = fakeClip({ id: 'clip_vision_degrade' });
  const dir = paths.clip(clip.id);
  fs.mkdirSync(dir, { recursive: true });
  // A tiny (1s, 64x64) real mp4 — critiqueRender's extractQcStills needs a real decodable file
  // before it ever reaches the (stubbed) LLM call.
  await runOk(ffmpeg(), [
    '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=30:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, 'render.mp4'),
  ]);

  const result = await critiqueRenderSafe(clip);
  expect(result.vision).toBeNull();
  expect(result.error).toContain('vision backend down again');
}, 20000);

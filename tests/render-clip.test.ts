import { it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// renderClip's timeout, failure and cleanup paths (HANDOFF open item #2), with Chrome, Remotion,
// the static server and ffmpeg all replaced by fakes. CB_DATA must be set before config.js loads.
process.env.CB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-render-clip-'));
const { renderClip } = await import('../src/render/render.js');
const { RenderTimeoutError } = await import('../src/render/watchdog.js');
const { saveClip, loadClip } = await import('../src/store.js');
const { SIGNALS } = await import('../src/types.js');
import type { Clip } from '../src/types.js';
import type { RenderDeps } from '../src/render/render.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise<never>(() => {});

function plannedClip(id: string): Clip {
  const now = new Date().toISOString();
  return {
    id, sourceId: 'src_x', creator: 'c', candidateId: 'cand_x', start: 10, end: 70, coldOpen: null,
    title: 'T', description: '', hashtags: [], hooks: [], hookIndex: 0,
    scores: Object.fromEntries(SIGNALS.map((s) => [s, { score: 5, reason: '' }])) as Clip['scores'],
    composite: 5, rankReason: '', patterns: [], hiresOffset: 9, status: 'planned', renders: 0, createdAt: now, updatedAt: now,
    edl: { fps: 30, width: 1080, height: 1920, videoSrc: 'hires.mp4', srcAspect: 16 / 9, segments: [], captions: [], hook: null, durationSec: 60, style: 'default' },
  };
}

type Events = string[];
function fakes(events: Events, overrides: Partial<RenderDeps> = {}): Partial<RenderDeps> {
  return {
    timeouts: () => ({ stallMs: 80, hardMs: 3000, warnings: [] }),
    getBundleLocation: async () => 'bundle',
    startStaticServer: async () => ({ url: 'http://127.0.0.1:1', close: async () => { events.push('server.close'); } }),
    openBrowser: async () => ({ close: async () => { events.push('browser.close'); } }),
    makeCancelSignal: () => {
      const cbs: (() => void)[] = [];
      return { cancelSignal: (cb: () => void) => { cbs.push(cb); }, cancel: () => { events.push('cancel'); cbs.forEach((f) => f()); } };
    },
    selectComposition: (async () => ({ id: 'Clip', durationInFrames: 1800, fps: 30, width: 1080, height: 1920 })) as unknown as RenderDeps['selectComposition'],
    renderMedia: (async () => { events.push('renderMedia.done'); return {}; }) as unknown as RenderDeps['renderMedia'],
    master: async () => { events.push('master'); },
    assertDeliverablePixelFormat: async () => {},
    makePoster: async () => { events.push('poster'); },
    ...overrides,
  };
}

let n = 0;
let id = '';
beforeEach(() => {
  id = `clip_rc${n++}`;
  saveClip(plannedClip(id));
});

it('a hung render (no progress) times out, cancels Remotion, closes its Chrome and the server, and leaves the clip unrendered', async () => {
  const events: Events = [];
  const t0 = Date.now();
  const err = await renderClip(id, fakes(events, {
    renderMedia: ((opts: { onProgress: (p: unknown) => void }) => { opts.onProgress({ renderedFrames: 120, encodedFrames: 100, progress: 0.07, stitchStage: 'encoding' }); return never(); }) as unknown as RenderDeps['renderMedia'],
  })).catch((e) => e);
  expect(err).toBeInstanceOf(RenderTimeoutError);
  expect(err.message).toMatch(/render timed out: no render progress for .* \(last progress: rendering frames, frame 120\/1800\)/);
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(events).toEqual(['cancel', 'browser.close', 'server.close']); // Chrome closed exactly once
  const c = loadClip(id);
  expect(c).toMatchObject({ status: 'planned', renders: 0 });
});

it('a slow render that keeps reporting progress is NOT timed out', async () => {
  const events: Events = [];
  await renderClip(id, fakes(events, {
    renderMedia: (async (opts: { onProgress: (p: unknown) => void }) => {
      for (let f = 1; f <= 12; f++) { await sleep(25); opts.onProgress({ renderedFrames: f * 150, encodedFrames: f * 150, progress: f / 12, stitchStage: 'encoding' }); }
      events.push('renderMedia.done');
      return {};
    }) as unknown as RenderDeps['renderMedia'],
  }));
  // ran ~300 ms against an 80 ms stall limit
  expect(events).toEqual(['renderMedia.done', 'browser.close', 'server.close', 'master', 'poster']);
  expect(loadClip(id)).toMatchObject({ status: 'rendered', renders: 1 });
});

it('a render that fails (lost connection) rejects with that error and still closes Chrome and the server', async () => {
  const events: Events = [];
  const err = await renderClip(id, fakes(events, {
    renderMedia: (async () => { throw new Error('Failed to fetch'); }) as unknown as RenderDeps['renderMedia'],
  })).catch((e) => e);
  expect(err.message).toBe('Failed to fetch');
  expect(events).toEqual(['browser.close', 'server.close']);
  expect(loadClip(id).status).toBe('planned');
});

it('a hang while loading the composition is caught too', async () => {
  const events: Events = [];
  const err = await renderClip(id, fakes(events, { selectComposition: (() => never()) as unknown as RenderDeps['selectComposition'] })).catch((e) => e);
  expect(err).toBeInstanceOf(RenderTimeoutError);
  expect(err.message).toMatch(/loading the composition/);
  expect(events).toEqual(['cancel', 'browser.close', 'server.close']);
});

it('a Chrome that only finishes launching after the timeout is closed, not leaked', async () => {
  const events: Events = [];
  const err = await renderClip(id, fakes(events, {
    openBrowser: async () => { await sleep(200); return { close: async () => { events.push('late-browser.close'); } }; },
  })).catch((e) => e);
  expect(err).toBeInstanceOf(RenderTimeoutError);
  await sleep(250);
  expect(events).toContain('late-browser.close');
});

it('Chrome or server teardown that throws does not hide the render error or block the caller', async () => {
  const events: Events = [];
  const err = await renderClip(id, fakes(events, {
    openBrowser: async () => ({ close: async () => { throw Object.assign(new Error('kill EPERM'), { code: 'EPERM', syscall: 'kill' }); } }),
    startStaticServer: async () => ({ url: 'http://127.0.0.1:1', close: async () => { throw new Error('server close failed'); } }),
    renderMedia: (async () => { throw new Error('Failed to fetch'); }) as unknown as RenderDeps['renderMedia'],
  })).catch((e) => e);
  expect(err.message).toBe('Failed to fetch');
});

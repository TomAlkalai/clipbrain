import { it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// `process.env.CB_DATA` must be set *before* `src/config.js` (which reads it into a top-level
// `DATA` const) is ever evaluated. A plain top-level `import` would be hoisted by the ESM spec
// ahead of this assignment, so — as the rest of this test suite does (see tests/store.test.ts,
// tests/stats.test.ts) — everything that transitively touches config.js/store.js is loaded via a
// dynamic `await import()` *after* the env var is set, never via a static `import` above it.
process.env.CB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-review-'));

const { createReviewServer, setJobRunner } = await import('../src/review/server.js');
const { saveClip, saveSource, saveCreator, loadClip, paths } = await import('../src/store.js');
import type { Clip, Source, Creator } from '../src/types.js';

function makeClip(overrides: Partial<Clip> = {}): Clip {
  const now = new Date().toISOString();
  return {
    id: 'clip_test1',
    sourceId: 'src_test1',
    creator: 'testcreator',
    candidateId: 'cand_test1',
    start: 10,
    end: 40,
    coldOpen: null,
    title: 'A test clip title',
    description: '',
    hashtags: [],
    hooks: [
      { text: 'Hook A', pattern: 'question', score: 8 },
      { text: 'Hook B', pattern: 'number', score: 7 },
    ],
    hookIndex: 0,
    scores: {
      hook: { score: 8, reason: 'good hook' },
      standalone_clarity: { score: 7, reason: 'clear' },
      payoff: { score: 6, reason: 'ok payoff' },
      novelty: { score: 5, reason: 'meh' },
      emotional_intensity: { score: 4, reason: 'flat' },
      information_density: { score: 7, reason: 'dense' },
      audience_fit: { score: 9, reason: 'fits' },
    },
    composite: 6.5,
    rankReason: 'because reasons',
    patterns: ['qa-punch-elaborate'],
    hiresOffset: 0,
    status: 'ready',
    renders: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Clip;
}

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'src_test1',
    creator: 'testcreator',
    kind: 'file',
    title: 'A Test Source Episode',
    durationSec: 3000,
    width: 1920,
    height: 1080,
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Source;
}

function makeCreator(): Creator {
  return {
    slug: 'testcreator',
    name: 'Test Creator',
    channelUrl: 'https://example.com/channel',
    referenceShortsUrls: [],
    clippingPermission: 'granted',
    createdAt: new Date().toISOString(),
  };
}

let server: { url: string; close: () => Promise<void> };

beforeAll(async () => {
  saveCreator(makeCreator());
  saveSource(makeSource());
  server = await createReviewServer({ port: 0 });
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  setJobRunner(async () => {
    /* no-op by default; individual tests override as needed */
  });
});

async function postJson(p: string, body: unknown): Promise<Response> {
  return fetch(`${server.url}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

it('GET /api/clips returns the clip without edl, with edlSummary and sourceTitle', async () => {
  saveClip(
    makeClip({
      id: 'clip_list1',
      edl: {
        fps: 30,
        width: 1080,
        height: 1920,
        videoSrc: 'hires.mp4',
        srcAspect: 16 / 9,
        segments: [
          { srcStart: 0, srcEnd: 5, layout: { kind: 'face', cx: 0.5, cy: 0.5, zoom: 1 } },
          { srcStart: 5, srcEnd: 10, layout: { kind: 'fit' } },
        ],
        captions: [],
        hook: null,
        durationSec: 10,
        style: 'default',
      },
    }),
  );

  const r = await fetch(`${server.url}/api/clips`);
  expect(r.status).toBe(200);
  const clips = (await r.json()) as any[];
  const found = clips.find((c) => c.id === 'clip_list1');
  expect(found).toBeTruthy();
  expect(found.edl).toBeUndefined();
  expect(found.edlSummary).toEqual({ segments: 2, layouts: { face: 1, fit: 1 } });
  expect(found.sourceTitle).toBe('A Test Source Episode');
});

it('POST /api/clips/:id/approve on a ready clip sets status approved on disk', async () => {
  saveClip(makeClip({ id: 'clip_approve1', status: 'ready' }));
  const r = await postJson('/api/clips/clip_approve1/approve', {});
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.status).toBe('approved');
  const onDisk = loadClip('clip_approve1');
  expect(onDisk.status).toBe('approved');
  expect(onDisk.review?.decision).toBe('approved');
  expect(onDisk.review?.at).toBeTruthy();
});

it('POST /api/clips/:id/approve on a qc_failed clip without override is rejected (409)', async () => {
  saveClip(makeClip({ id: 'clip_qcf1', status: 'qc_failed' }));
  const r = await postJson('/api/clips/clip_qcf1/approve', {});
  expect(r.status).toBe(409);
  const onDisk = loadClip('clip_qcf1');
  expect(onDisk.status).toBe('qc_failed');
});

it('POST /api/clips/:id/approve with override:true on qc_failed sets the R4 reason prefix', async () => {
  saveClip(makeClip({ id: 'clip_qcf2', status: 'qc_failed' }));
  const r = await postJson('/api/clips/clip_qcf2/approve', { override: true, note: 'looks fine to me' });
  expect(r.status).toBe(200);
  const onDisk = loadClip('clip_qcf2');
  expect(onDisk.status).toBe('approved');
  expect(onDisk.review?.decision).toBe('approved');
  expect(onDisk.review?.reason).toBe('override: looks fine to me');
});

it('POST /api/clips/:id/approve with override:true and no note uses the default reason', async () => {
  saveClip(makeClip({ id: 'clip_qcf3', status: 'qc_failed' }));
  const r = await postJson('/api/clips/clip_qcf3/approve', { override: true });
  expect(r.status).toBe(200);
  const onDisk = loadClip('clip_qcf3');
  expect(onDisk.review?.reason).toBe('override: qc_failed approved by reviewer');
});

it('POST /api/clips/:id/approve with override:true and an explicit empty-string note does NOT fall back to the default (R4: note ?? default)', async () => {
  saveClip(makeClip({ id: 'clip_qcf4', status: 'qc_failed' }));
  const r = await postJson('/api/clips/clip_qcf4/approve', { override: true, note: '' });
  expect(r.status).toBe(200);
  const onDisk = loadClip('clip_qcf4');
  expect(onDisk.review?.reason).toBe('override: ');
});

it('POST /api/clips/:id/reject without a reason is a 400 and does not change status', async () => {
  saveClip(makeClip({ id: 'clip_reject1', status: 'ready' }));
  const r = await postJson('/api/clips/clip_reject1/reject', {});
  expect(r.status).toBe(400);
  const onDisk = loadClip('clip_reject1');
  expect(onDisk.status).toBe('ready');
});

it('POST /api/clips/:id/reject with a reason sets status rejected on disk', async () => {
  saveClip(makeClip({ id: 'clip_reject2', status: 'ready' }));
  const r = await postJson('/api/clips/clip_reject2/reject', { reason: 'weak hook' });
  expect(r.status).toBe(200);
  const onDisk = loadClip('clip_reject2');
  expect(onDisk.status).toBe('rejected');
  expect(onDisk.review).toEqual({ decision: 'rejected', reason: 'weak hook', at: onDisk.review!.at });
});

it('POST /api/clips/:id/hook enqueues a rerender job and returns a jobId (stubbed runner)', async () => {
  saveClip(makeClip({ id: 'clip_hook1', hookIndex: 0 }));
  let ran: string[] = [];
  setJobRunner(async (clipId: string) => {
    ran.push(clipId);
  });
  const r = await postJson('/api/clips/clip_hook1/hook', { index: 1 });
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(typeof body.jobId).toBe('string');

  // hookIndex is persisted immediately, before the (possibly async) job even runs.
  const onDisk = loadClip('clip_hook1');
  expect(onDisk.hookIndex).toBe(1);

  // wait for the (stubbed, instant) job to drain through the FIFO queue
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(ran).toEqual(['clip_hook1']);

  const jobsRes = await fetch(`${server.url}/api/jobs`);
  const jobs = (await jobsRes.json()) as any[];
  const job = jobs.find((j) => j.id === body.jobId);
  expect(job).toBeTruthy();
  expect(job.clipId).toBe('clip_hook1');
  expect(job.kind).toBe('rerender');
  expect(job.status).toBe('done');
});

it('POST /api/clips/:id/hook with an out-of-range index is a 400', async () => {
  saveClip(makeClip({ id: 'clip_hook2', hookIndex: 0 }));
  const r = await postJson('/api/clips/clip_hook2/hook', { index: 5 });
  expect(r.status).toBe(400);
});

it('a job runner error is reflected as job status error with a message, and persisted onto clip.error on disk', async () => {
  saveClip(makeClip({ id: 'clip_hook3', hookIndex: 0 }));
  setJobRunner(async () => {
    throw new Error('boom');
  });
  const r = await postJson('/api/clips/clip_hook3/hook', { index: 1 });
  const body = await r.json();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const jobsRes = await fetch(`${server.url}/api/jobs`);
  const jobs = (await jobsRes.json()) as any[];
  const job = jobs.find((j) => j.id === body.jobId);
  expect(job.status).toBe('error');
  expect(job.error).toMatch(/boom/);

  const onDisk = loadClip('clip_hook3');
  expect(onDisk.error).toMatch(/boom/);
});

it('a subsequent successful rerender job clears a previously-persisted clip.error', async () => {
  saveClip(makeClip({ id: 'clip_hook4', hookIndex: 0, error: 'stale error from a prior failed job' }));

  setJobRunner(async () => {
    /* succeeds */
  });
  const r = await postJson('/api/clips/clip_hook4/hook', { index: 1 });
  expect(r.status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const onDisk = loadClip('clip_hook4');
  expect(onDisk.error).toBeUndefined();
});

it('a request body over 1MB is rejected with 413 (and does not touch the clip)', async () => {
  saveClip(makeClip({ id: 'clip_bigbody1', title: 'untouched title' }));
  const hugeTitle = 'x'.repeat(1024 * 1024 + 100); // > 1MB once JSON-serialized
  const r = await fetch(`${server.url}/api/clips/clip_bigbody1/title`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: hugeTitle }),
  });
  expect(r.status).toBe(413);
  const onDisk = loadClip('clip_bigbody1');
  expect(onDisk.title).toBe('untouched title');
});

it('POST /api/clips/:id/title updates the title', async () => {
  saveClip(makeClip({ id: 'clip_title1', title: 'old title' }));
  const r = await postJson('/api/clips/clip_title1/title', { title: 'new title' });
  expect(r.status).toBe(200);
  const onDisk = loadClip('clip_title1');
  expect(onDisk.title).toBe('new title');
});

it('POST /api/clips/:id/title rejects a title over 100 chars', async () => {
  saveClip(makeClip({ id: 'clip_title2', title: 'old title' }));
  const r = await postJson('/api/clips/clip_title2/title', { title: 'x'.repeat(101) });
  expect(r.status).toBe(400);
  const onDisk = loadClip('clip_title2');
  expect(onDisk.title).toBe('old title');
});

it('POST /api/clips/:id/schedule sets plannedPublishAt', async () => {
  saveClip(makeClip({ id: 'clip_sched1' }));
  const r = await postJson('/api/clips/clip_sched1/schedule', { publishAt: '2026-10-01T12:00:00.000Z' });
  expect(r.status).toBe(200);
  const onDisk = loadClip('clip_sched1');
  expect(onDisk.plannedPublishAt).toBe('2026-10-01T12:00:00.000Z');
});

it('POST /api/clips/:id/schedule with null clears plannedPublishAt', async () => {
  saveClip(makeClip({ id: 'clip_sched2', plannedPublishAt: '2026-10-01T12:00:00.000Z' }));
  const r = await postJson('/api/clips/clip_sched2/schedule', { publishAt: null });
  expect(r.status).toBe(200);
  const onDisk = loadClip('clip_sched2');
  expect(onDisk.plannedPublishAt).toBeUndefined();
});

it('POST /api/clips/:id/schedule on a published clip is a 409', async () => {
  saveClip(
    makeClip({
      id: 'clip_sched3',
      status: 'published',
      publish: { videoId: 'yt1', privacy: 'private', at: new Date().toISOString(), dryRun: true },
    }),
  );
  const r = await postJson('/api/clips/clip_sched3/schedule', { publishAt: '2026-10-01T12:00:00.000Z' });
  expect(r.status).toBe(409);
});

it('GET /api/summary returns counts by status and a ledger summary', async () => {
  saveClip(makeClip({ id: 'clip_sum1', status: 'ready' }));
  saveClip(makeClip({ id: 'clip_sum2', status: 'approved' }));
  const r = await fetch(`${server.url}/api/summary`);
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.counts.ready).toBeGreaterThanOrEqual(1);
  expect(body.counts.approved).toBeGreaterThanOrEqual(1);
  expect(body.ledger).toBeTruthy();
  expect(typeof body.ledger.costUsd).toBe('number');
});

it('GET /media/clips/:id/render.mp4 serves the file with Range support', async () => {
  const dir = paths.clip('clip_media1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'render.mp4'), Buffer.from('0123456789'));
  saveClip(makeClip({ id: 'clip_media1' }));

  const full = await fetch(`${server.url}/media/clips/clip_media1/render.mp4`);
  expect(full.status).toBe(200);
  const ranged = await fetch(`${server.url}/media/clips/clip_media1/render.mp4`, { headers: { Range: 'bytes=2-5' } });
  expect(ranged.status).toBe(206);
  expect(await ranged.text()).toBe('2345');
});

it('GET /media/clips/:id/render.mp4 refuses path traversal via the id segment', async () => {
  const r = await fetch(`${server.url}/media/clips/../../../etc/passwd/render.mp4`);
  expect(r.status).toBeGreaterThanOrEqual(400);
});

it('GET / serves the ui.html page', async () => {
  const r = await fetch(`${server.url}/`);
  expect(r.status).toBe(200);
  const text = await r.text();
  expect(text).toMatch(/<html/i);
});

it('GET /api/jobs returns an array (initially may be non-empty from earlier tests, but well-formed)', async () => {
  const r = await fetch(`${server.url}/api/jobs`);
  expect(r.status).toBe(200);
  const jobs = await r.json();
  expect(Array.isArray(jobs)).toBe(true);
});

// Review finding: binding to 127.0.0.1 alone doesn't stop a web page in the user's browser from
// driving this API — via DNS rebinding (a foreign Host header) or a plain cross-site POST (a
// foreign Origin header). Both are refused.
import http from 'node:http';
function rawRequest(method: string, p: string, headers: Record<string, string>, body?: string): Promise<number> {
  const u = new URL(server.url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, method, path: p, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(body);
  });
}

it('refuses a request whose Host is not a loopback name (DNS rebinding)', async () => {
  expect(await rawRequest('GET', '/api/clips', { Host: 'evil.example:4777' })).toBe(403);
  expect(await rawRequest('GET', '/api/clips', { Host: `localhost:${new URL(server.url).port}` })).toBe(200);
});

it('refuses a cross-site POST (foreign Origin) and allows the UI’s own origin', async () => {
  saveClip(makeClip({ id: 'clip_csrf', status: 'ready' }));
  const port = new URL(server.url).port;
  const body = JSON.stringify({ reason: 'nope' });
  expect(await rawRequest('POST', '/api/clips/clip_csrf/reject', { Host: `127.0.0.1:${port}`, Origin: 'https://evil.example', 'Content-Type': 'text/plain' }, body)).toBe(403);
  expect(loadClip('clip_csrf').status).toBe('ready');
  expect(await rawRequest('POST', '/api/clips/clip_csrf/reject', { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' }, body)).toBe(200);
  expect(loadClip('clip_csrf').status).toBe('rejected');
});

it('isAllowedRequest: loopback hosts only; Origin must be this server on state-changing requests', async () => {
  const { isAllowedRequest } = await import('../src/review/server.js');
  expect(isAllowedRequest('GET', '127.0.0.1:4777', undefined, 4777)).toBe(true);
  expect(isAllowedRequest('GET', '[::1]:4777', undefined, 4777)).toBe(true);
  expect(isAllowedRequest('GET', undefined, undefined, 4777)).toBe(false);
  expect(isAllowedRequest('GET', '127.0.0.1.evil.example', undefined, 4777)).toBe(false);
  expect(isAllowedRequest('POST', 'localhost:4777', 'http://localhost:4777', 4777)).toBe(true);
  expect(isAllowedRequest('POST', 'localhost:4777', 'http://localhost:3000', 4777)).toBe(false); // another local app
  expect(isAllowedRequest('POST', 'localhost:4777', 'null', 4777)).toBe(false);
  expect(isAllowedRequest('POST', 'localhost:4777', undefined, 4777)).toBe(true); // curl / same-origin without Origin
});

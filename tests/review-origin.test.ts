import { it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// Review finding: binding to 127.0.0.1 alone doesn't stop a web page in the user's browser from
// driving the review API — via DNS rebinding (a foreign Host header) or a plain cross-site POST (a
// foreign Origin header). Both are refused. CB_DATA must be set before config.js is first loaded.
process.env.CB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-review-origin-'));
const { createReviewServer, isAllowedRequest } = await import('../src/review/server.js');
const { saveClip, loadClip } = await import('../src/store.js');
const { SIGNALS } = await import('../src/types.js');
import type { Clip } from '../src/types.js';

function readyClip(id: string): Clip {
  const now = new Date().toISOString();
  return {
    id, sourceId: 'src_x', creator: 'nobody', candidateId: 'cand_x', start: 0, end: 60, coldOpen: null,
    title: 'T', description: '', hashtags: [], hooks: [{ text: 'H', pattern: 'p', score: 5 }], hookIndex: 0,
    scores: Object.fromEntries(SIGNALS.map((s) => [s, { score: 5, reason: 'r' }])) as Clip['scores'],
    composite: 5, rankReason: '', patterns: [], hiresOffset: 0, status: 'ready', renders: 1, createdAt: now, updatedAt: now,
  };
}

let server: { url: string; close: () => Promise<void> };
beforeAll(async () => { server = await createReviewServer({ port: 0 }); });
afterAll(async () => { await server.close(); });

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
  saveClip(readyClip('clip_csrf'));
  const port = new URL(server.url).port;
  const body = JSON.stringify({ reason: 'nope' });
  expect(await rawRequest('POST', '/api/clips/clip_csrf/reject', { Host: `127.0.0.1:${port}`, Origin: 'https://evil.example', 'Content-Type': 'text/plain' }, body)).toBe(403);
  expect(loadClip('clip_csrf').status).toBe('ready');
  expect(await rawRequest('POST', '/api/clips/clip_csrf/reject', { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' }, body)).toBe(200);
  expect(loadClip('clip_csrf').status).toBe('rejected');
});

it('isAllowedRequest: loopback hosts only; Origin must be this server on state-changing requests', () => {
  expect(isAllowedRequest('GET', '127.0.0.1:4777', undefined, 4777)).toBe(true);
  expect(isAllowedRequest('GET', '[::1]:4777', undefined, 4777)).toBe(true);
  expect(isAllowedRequest('GET', undefined, undefined, 4777)).toBe(false);
  expect(isAllowedRequest('GET', '127.0.0.1.evil.example', undefined, 4777)).toBe(false);
  expect(isAllowedRequest('POST', 'localhost:4777', 'http://localhost:4777', 4777)).toBe(true);
  expect(isAllowedRequest('POST', 'localhost:4777', 'http://localhost:3000', 4777)).toBe(false); // another local app
  expect(isAllowedRequest('POST', 'localhost:4777', 'null', 4777)).toBe(false);
  expect(isAllowedRequest('POST', 'localhost:4777', undefined, 4777)).toBe(true); // curl / same-origin without Origin
});

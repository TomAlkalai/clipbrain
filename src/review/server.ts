import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { DATA } from '../config.js';
import { listClips, loadClip, saveClip, loadSource, newId } from '../store.js';
import { serveFile } from '../render/static.js';
import { rebuildEdl } from '../produce.js';
import { renderClip } from '../render/render.js';
import { qcClip } from '../qc/qc.js';
import { ledgerSummary } from '../llm/llm.js';
import { loadPlaybook, type Playbook } from '../playbook/playbook.js';
import { isPublished } from '../publish/state.js';
import type { Clip, ClipStatus, Edl } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_HTML_PATH = path.join(__dirname, 'ui.html');

// ---- Job queue (in-memory FIFO, one job running at a time) ----

export type JobKind = 'rerender';
export type JobStatusName = 'queued' | 'running' | 'done' | 'error';
export type Job = { id: string; clipId: string; kind: JobKind; status: JobStatusName; error?: string };

type JobRunner = (clipId: string) => Promise<void>;

// The real job: rebuild the EDL from the clip's (possibly just-changed) hookIndex/start/end, then
// re-render and re-run QC — per controller ruling: rebuildEdl(clip) -> renderClip(clipId) ->
// qcClip(clipId). Exported as `setJobRunner` so tests can stub the whole pipeline (which needs
// ffmpeg/Remotion/an LLM backend) with something instant and deterministic.
let jobRunner: JobRunner = async (clipId: string) => {
  const clip = loadClip(clipId);
  await rebuildEdl(clip);
  await renderClip(clipId);
  await qcClip(clipId);
};

export function setJobRunner(fn: JobRunner): void {
  jobRunner = fn;
}

const jobs: Job[] = [];
const queue: string[] = [];
let draining = false;

// Reloads the clip fresh from disk and persists `clip.error` (set on job failure, cleared on job
// success) without disturbing whatever fields the job itself already wrote (qc, status, edl, ...).
// Swallows a missing/unreadable clip — the job's own status/error on `/api/jobs` still surfaces
// the failure either way, this is just the "show it on the card" persistence the UI reads.
function persistClipError(clipId: string, message: string | undefined): void {
  try {
    const clip = loadClip(clipId);
    if (message === undefined) {
      if (clip.error === undefined) return; // nothing to clear
      delete clip.error;
    } else {
      clip.error = message;
    }
    saveClip(clip);
  } catch {
    /* clip missing/unreadable — ignore */
  }
}

async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const id = queue.shift()!;
      const job = jobs.find((j) => j.id === id);
      if (!job) continue;
      job.status = 'running';
      try {
        await jobRunner(job.clipId);
        job.status = 'done';
        persistClipError(job.clipId, undefined);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        job.status = 'error';
        job.error = message;
        persistClipError(job.clipId, message);
      }
    }
  } finally {
    draining = false;
  }
}

function enqueueRerender(clipId: string): Job {
  const job: Job = { id: newId('job'), clipId, kind: 'rerender', status: 'queued' };
  jobs.push(job);
  queue.push(job.id);
  void drainQueue();
  return job;
}

// ---- Clip API shaping ----

function edlSummaryOf(edl?: Edl): { segments: number; layouts: Record<string, number> } {
  if (!edl) return { segments: 0, layouts: {} };
  const layouts: Record<string, number> = {};
  for (const seg of edl.segments) layouts[seg.layout.kind] = (layouts[seg.layout.kind] ?? 0) + 1;
  return { segments: edl.segments.length, layouts };
}

const playbookCache = new Map<string, Playbook>();
function playbookFor(creator: string): Playbook {
  let pb = playbookCache.get(creator);
  if (!pb) {
    pb = loadPlaybook(creator);
    playbookCache.set(creator, pb);
  }
  return pb;
}

// Builds the API-facing shape of a clip: the full clip JSON (including any fields not yet in the
// `Clip` type, e.g. candidate `visual`/`boundary` signals a future task may copy onto it) minus
// `edl` (replaced by a small summary), plus the source's title and the creator's ideal-duration
// bounds for context.
function clipForApi(clip: Clip): Record<string, unknown> {
  const raw = clip as unknown as Record<string, unknown>;
  const { edl, ...rest } = raw;
  let sourceTitle: string | undefined;
  try {
    sourceTitle = loadSource(clip.sourceId).title;
  } catch {
    sourceTitle = undefined;
  }
  let idealDurationSec: { min: number; max: number } | undefined;
  try {
    idealDurationSec = playbookFor(clip.creator).idealDurationSec;
  } catch {
    idealDurationSec = undefined;
  }
  return { ...rest, edlSummary: edlSummaryOf(clip.edl), sourceTitle, idealDurationSec };
}

// ---- HTTP helpers ----

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

// Distinguishes "body too large" (413) from "body isn't valid JSON" (400) for callers of
// `readBody`. Rejected as soon as the running byte count crosses the cap, so we stop buffering
// into `data` at that point (bounding memory) — but the request stream itself is deliberately
// *not* destroyed here: doing so races the client's still-in-flight upload and tends to surface
// as a raw socket-reset/`fetch failed` on their end instead of the 413 response we want them to
// see. Left flowing, the remaining bytes are simply drained and ignored, `end` fires normally,
// and the 413 gets written and flushed like any other response.
export class PayloadTooLargeError extends Error {}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (settled) return;
      if (bytes > MAX_BODY_BYTES) {
        settled = true;
        reject(new PayloadTooLargeError(`request body exceeds ${MAX_BODY_BYTES} byte limit`));
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (!data.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

type Result = { status: number; body: unknown };

function notFound(msg = 'not found'): Result {
  return { status: 404, body: { error: msg } };
}
function badRequest(msg: string): Result {
  return { status: 400, body: { error: msg } };
}
function conflict(msg: string): Result {
  return { status: 409, body: { error: msg } };
}
function ok(body: unknown): Result {
  return { status: 200, body };
}

// ---- Route handlers ----

function listClipsApi(): Result {
  const clips = listClips().slice().reverse(); // store sorts oldest-first; API wants newest-first
  return ok(clips.map(clipForApi));
}

function listJobsApi(): Result {
  return ok(jobs.map((j) => ({ id: j.id, clipId: j.clipId, kind: j.kind, status: j.status, ...(j.error ? { error: j.error } : {}) })));
}

const ALL_STATUSES: ClipStatus[] = ['planned', 'rendered', 'qc_failed', 'ready', 'approved', 'rejected', 'published'];

function summaryApi(): Result {
  const clips = listClips();
  const counts = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<ClipStatus, number>;
  for (const c of clips) counts[c.status] = (counts[c.status] ?? 0) + 1;
  return ok({ counts, ledger: ledgerSummary() });
}

function approveClip(id: string, body: any): Result {
  let clip: Clip;
  try {
    clip = loadClip(id);
  } catch {
    return notFound(`clip ${id} not found`);
  }
  const override = body?.override === true;
  const overriding = clip.status === 'qc_failed' && override;
  const canApprove = clip.status === 'ready' || overriding;
  if (!canApprove) {
    return conflict(`cannot approve clip with status '${clip.status}'${clip.status === 'qc_failed' ? ' without override:true' : ''}`);
  }

  const at = new Date().toISOString();
  if (overriding) {
    // R4: `note ?? default` — an explicit empty-string note is a deliberate choice by the
    // reviewer and must NOT be swapped for the default message; only a missing/non-string note
    // (the key omitted entirely, or the wrong type) falls back to it.
    const note = typeof body?.note === 'string' ? body.note : undefined;
    clip.review = { decision: 'approved', reason: `override: ${note ?? 'qc_failed approved by reviewer'}`, at };
  } else {
    const note = typeof body?.note === 'string' && body.note.trim() ? body.note.trim() : undefined;
    clip.review = { decision: 'approved', ...(note ? { reason: note } : {}), at };
  }
  clip.status = 'approved';
  saveClip(clip);
  return ok(clipForApi(clip));
}

function rejectClip(id: string, body: any): Result {
  let clip: Clip;
  try {
    clip = loadClip(id);
  } catch {
    return notFound(`clip ${id} not found`);
  }
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (!reason) return badRequest('reason is required and must be non-empty');
  if (clip.status === 'published') return conflict('cannot reject a published clip');

  clip.review = { decision: 'rejected', reason, at: new Date().toISOString() };
  clip.status = 'rejected';
  saveClip(clip);
  return ok(clipForApi(clip));
}

function hookClip(id: string, body: any): Result {
  let clip: Clip;
  try {
    clip = loadClip(id);
  } catch {
    return notFound(`clip ${id} not found`);
  }
  // A hook change re-renders the clip, which resets its status: a published clip would drop back
  // into review and could be approved and uploaded a second time.
  if (isPublished(clip)) return conflict('cannot change the hook of a published clip — it is already on YouTube');
  const index = body?.index;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= clip.hooks.length) {
    return badRequest(`index must be an integer in [0, ${clip.hooks.length})`);
  }
  clip.hookIndex = index;
  saveClip(clip);
  const job = enqueueRerender(id);
  return ok({ jobId: job.id });
}

function titleClip(id: string, body: any): Result {
  let clip: Clip;
  try {
    clip = loadClip(id);
  } catch {
    return notFound(`clip ${id} not found`);
  }
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  if (!title) return badRequest('title is required and must be non-empty');
  if (title.length > 100) return badRequest('title must be <= 100 chars');
  clip.title = title;
  saveClip(clip);
  return ok(clipForApi(clip));
}

function scheduleClip(id: string, body: any): Result {
  let clip: Clip;
  try {
    clip = loadClip(id);
  } catch {
    return notFound(`clip ${id} not found`);
  }
  if (clip.status === 'published') return conflict('cannot reschedule a published clip');

  const publishAt = body?.publishAt;
  if (publishAt === null || publishAt === undefined) {
    delete clip.plannedPublishAt;
  } else if (typeof publishAt === 'string' && !Number.isNaN(Date.parse(publishAt))) {
    clip.plannedPublishAt = publishAt;
  } else {
    return badRequest('publishAt must be an ISO date string or null');
  }
  saveClip(clip);
  return ok(clipForApi(clip));
}

// ---- Router ----

const CLIP_ACTION_RE = /^\/api\/clips\/([^/]+)\/(approve|reject|hook|title|schedule)$/;
const MEDIA_RE = /^\/media\/clips\/([^/]+)\/(render\.mp4|poster\.jpg)$/;

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Binding to 127.0.0.1 alone doesn't stop a web page open in the user's browser from driving this
 * API. A foreign Host header means DNS rebinding (an attacker domain resolved to 127.0.0.1); a
 * foreign Origin on a state-changing request means a cross-site form/fetch POST. Both are refused.
 * Browsers always send Origin on cross-origin POSTs; same-origin UI requests and non-browser
 * clients (curl, tests) may omit it and are allowed. Pure.
 */
export function isAllowedRequest(method: string, host: string | undefined, origin: string | undefined, serverPort: number): boolean {
  const hostname = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec((host ?? '').trim().toLowerCase())?.[1];
  if (!hostname || !LOOPBACK_HOSTNAMES.has(hostname)) return false;
  if (method === 'GET' || method === 'HEAD' || origin === undefined) return true;
  try {
    const o = new URL(origin);
    return LOOPBACK_HOSTNAMES.has(o.hostname) && Number(o.port) === serverPort;
  } catch {
    return false; // e.g. "null" from a sandboxed iframe or file:// page
  }
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!isAllowedRequest(req.method ?? 'GET', req.headers.host, req.headers.origin, req.socket.localPort ?? 0)) {
    sendJson(res, 403, { error: 'forbidden: this API only accepts requests from the local review UI' });
    return;
  }
  const u = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = u.pathname;

  try {
    if (req.method === 'GET' && pathname === '/') {
      const html = fs.readFileSync(UI_HTML_PATH);
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': html.length });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/clips') {
      const r = listClipsApi();
      sendJson(res, r.status, r.body);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/jobs') {
      const r = listJobsApi();
      sendJson(res, r.status, r.body);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/summary') {
      const r = summaryApi();
      sendJson(res, r.status, r.body);
      return;
    }

    const mediaMatch = MEDIA_RE.exec(pathname);
    if (req.method === 'GET' && mediaMatch) {
      const [, id, file] = mediaMatch;
      serveFile(req, res, path.join(DATA, 'clips'), `${id}/${file}`);
      return;
    }

    const actionMatch = CLIP_ACTION_RE.exec(pathname);
    if (req.method === 'POST' && actionMatch) {
      const [, id, action] = actionMatch;
      let body: any;
      try {
        body = await readBody(req);
      } catch (err) {
        if (err instanceof PayloadTooLargeError) {
          sendJson(res, 413, { error: err.message });
        } else {
          sendJson(res, 400, { error: 'invalid JSON body' });
        }
        return;
      }
      let r: Result;
      switch (action) {
        case 'approve':
          r = approveClip(id, body);
          break;
        case 'reject':
          r = rejectClip(id, body);
          break;
        case 'hook':
          r = hookClip(id, body);
          break;
        case 'title':
          r = titleClip(id, body);
          break;
        case 'schedule':
          r = scheduleClip(id, body);
          break;
        default:
          r = notFound();
      }
      sendJson(res, r.status, r.body);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Starts the local human-in-the-loop review server: JSON API + `ui.html` + a `/media/clips/...`
 * range-serving route, bound to 127.0.0.1 only (default port 4777, `o.port` for tests/overrides —
 * pass `0` for an ephemeral port).
 */
export async function createReviewServer(o?: { port?: number }): Promise<{ url: string; close: () => Promise<void> }> {
  const port = o?.port ?? 4777;
  const server = http.createServer((req, res) => {
    void handleRequest(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

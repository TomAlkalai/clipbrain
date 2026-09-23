# Clip Brain MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local CLI + review UI that learns a creator's clipping playbook from their official Shorts, then turns a long-form episode into ranked, reframed, captioned, QC-checked vertical clips that can be approved, published to YouTube, measured, and fed back into the playbook.

**Architecture:** Node 22 + TypeScript (run with `tsx`, no build step). Each pipeline stage reads/writes JSON files under `data/`. Heavy media work is local (full ffmpeg, whisper.cpp, onnxruntime face detection); reasoning goes through a tiered LLM adapter that shells out to `claude -p` with JSON-schema output. Remotion renders clips from an Edit Decision List (EDL).

**Tech Stack:** Node 22.11, TypeScript 5, tsx, vitest, Remotion 4.0.527 (`remotion`, `@remotion/bundler`, `@remotion/renderer`, `@remotion/install-whisper-cpp`, `@remotion/google-fonts`), onnxruntime-node, google-auth-library, yt-dlp.exe (standalone), FFmpeg 9 full build (winget Gyan.FFmpeg), Claude Code CLI 2.1.x.

**Spec:** `docs/superpowers/specs/2026-09-23-clipbrain-design.md`

## Global Constraints

- Repo root: `C:\Users\tomal\clipbrain` (outside OneDrive). All data under `data/` (gitignored). Tools under `bin/` (gitignored). Secrets under `.secrets/` and `.env` (gitignored).
- Disk: only ~17 GB free. Never download full-resolution full episodes; hi-res is fetched per clip window only. Proxy is ≤360p.
- ffmpeg/ffprobe: resolve in this order: `FFMPEG_PATH` env → `C:\Users\tomal\AppData\Local\Microsoft\WinGet\Links\ffmpeg.exe` → `ffmpeg` on PATH. Same for ffprobe. The Remotion-bundled ffmpeg lacks most filters — do not use it for analysis.
- yt-dlp: `bin/yt-dlp.exe`; always pass `--js-runtimes node` (YouTube extraction needs a JS runtime) and `--no-warnings`, and for batches `--sleep-requests 1`.
- LLM tiers: `fast` = `haiku`, `balanced` = `sonnet`, `strong` = `opus`. All calls: `claude -p --model <m> --output-format json --json-schema <schema> --tools "" --safe-mode --no-session-persistence --strict-mcp-config`, prompt on stdin, cwd = `data/.llm-sandbox` (empty dir). Parse `structured_output` from the JSON result; record `total_cost_usd`.
- Times in all JSON are **seconds (float)**. Normalized coordinates are 0..1 relative to the source frame.
- Output video: 1080×1920, 30 fps, H.264 (crf 18) + AAC 48 kHz, loudness −14 LUFS integrated, true peak ≤ −1.0 dBTP.
- Clip duration bounds default: 20–75 s (playbook may override within 12–120 s).
- No single "viral score": 7 signals — `hook, standalone_clarity, payoff, novelty, emotional_intensity, information_density, audience_fit` (0–10 each, with reason).
- Publishing: only `approved` + QC `ready` clips; dry-run unless `--live`; default privacy `private`; daily cap (default 10); authenticated channel id must equal `creator.publishChannelId`.
- Every LLM call is cached on disk by sha256(model+system+prompt+schema) and logged to `data/ledger.jsonl`.
- Style: ESM (`"type":"module"`), strict TS, small focused files, no classes unless state is needed. Tests in `tests/` mirror `src/`.

## File Structure

```
package.json  tsconfig.json  vitest.config.ts  .env.example  README.md
src/
  types.ts               shared data types (the contract between all tasks)
  config.ts              paths + env
  store.ts               JSON IO, ids, per-entity paths
  log.ts                 tiny logger
  tools/proc.ts          run external processes
  tools/bins.ts          resolve ffmpeg/ffprobe/yt-dlp/whisper/ultraface; setup downloads
  llm/claude.ts          claude CLI backend
  llm/llm.ts             tiered API: cache, ledger, concurrency
  text/tokens.ts         normalize + tokenize
  text/json3.ts          YouTube json3 subtitles → Word[]
  text/sentences.ts      Word[] → Sentence[]
  yt/ytdlp.ts            channel listing, subtitles, audio/proxy/section downloads
  mine/align.ts          short ↔ episode alignment (pure)
  mine/features.ts       transformation features + performance normalization (pure)
  mine/mine.ts           creator mining orchestrator
  playbook/playbook.ts   types, defaults, load/save, markdown render, prompt block
  playbook/distill.ts    LLM distillation
  ingest.ts              source ingestion
  analyze/transcribe.ts  whisper.cpp → words
  analyze/silences.ts    ffmpeg silencedetect → silences
  analyze/frames.ts      raw frame stream from ffmpeg
  analyze/shots.ts       shot boundary detection (pure core)
  analyze/faces.ts       UltraFace ONNX detection
  analyze/analyze.ts     orchestrator
  select/snap.ts         boundary snapping + dedupe (pure)
  select/propose.ts      LLM candidate proposal per window
  select/rank.ts         composite + LLM final ranking
  select/select.ts       orchestrator
  hooks/hooks.ts         hook variants/title/cold-open
  edit/crop.ts           per-segment layout planning (pure)
  edit/edl.ts            EDL builder (pure)
  render/static.ts       static file server with Range support
  render/render.ts       hi-res fetch, Remotion render, loudness master
  qc/rules.ts            QC decision rules (pure)
  qc/qc.ts               QC runner + auto-fix
  produce.ts             hooks→edl→render→qc for shortlisted candidates
  eval.ts                compare picks vs official shorts from same episode
  review/server.ts       HTTP API + job queue
  review/ui.html         single-page review UI
  publish/oauth.ts       Google OAuth installed-app flow
  publish/youtube.ts     upload + channel check + safeguards
  metrics/stats.ts       analytics collection
  learn/learn.ts         feedback → playbook weights/ownResults (pure core)
  cli.ts                 command dispatcher
remotion/
  index.ts  Root.tsx  Clip.tsx  VideoLayer.tsx  Captions.tsx  HookOverlay.tsx  style.ts
tests/  (mirrors src/, *.test.ts)
```

## Shared Types — `src/types.ts` (created in Task 1, used everywhere)

```ts
export type Word = { w: string; start: number; end: number };
export type Sentence = { id: number; text: string; start: number; end: number; w0: number; w1: number };
export type Silence = { start: number; end: number };
export type Shot = { start: number; end: number };
export type FaceBox = { x: number; y: number; w: number; h: number; score: number }; // normalized, top-left origin
export type FaceSample = { t: number; faces: FaceBox[] };
export type Rect = { x: number; y: number; w: number; h: number }; // normalized

export type SignalName = 'hook' | 'standalone_clarity' | 'payoff' | 'novelty' | 'emotional_intensity' | 'information_density' | 'audience_fit';
export const SIGNALS: SignalName[] = ['hook', 'standalone_clarity', 'payoff', 'novelty', 'emotional_intensity', 'information_density', 'audience_fit'];
export type Scores = Record<SignalName, { score: number; reason: string }>;

export type Creator = {
  slug: string; name: string; channelUrl: string; referenceShortsUrls: string[];
  clippingPermission: string; publishChannelId?: string;
  layoutOverride?: { kind: 'stream'; cam: Rect; main: Rect };
  createdAt: string;
};

export type RefShort = { id: string; title: string; views: number; uploadDate: string; durationSec: number; channelUrl: string };
export type AlignedSegment = { shortStart: number; shortEnd: number; srcStart: number; srcEnd: number; tokens: number };
export type Alignment = { shortId: string; episodeId: string; segments: AlignedSegment[]; coverage: number; hits: number };
export type ShortFeatures = {
  shortId: string; episodeId: string; title: string; views: number; perf: number; // perf = ln(views/median)
  durationSec: number; srcSpanSec: number; nSegments: number; coldOpen: boolean; tightened: boolean;
  startsAfterPause: boolean; positionInEpisode: number; text: string; contextBefore: string;
};

export type Source = {
  id: string; creator: string; kind: 'youtube' | 'file'; url?: string; filePath?: string; videoId?: string;
  title: string; durationSec: number; width: number; height: number; createdAt: string;
};

export type Candidate = {
  id: string; sourceId: string; startSid: number; endSid: number; start: number; end: number;
  title: string; summary: string; why: string; patterns: string[]; scores: Scores; composite: number;
  rank?: number; rankReason?: string; shortlisted: boolean;
};

export type Hook = { text: string; pattern: string; score: number };
export type Layout =
  | { kind: 'face'; cx: number; cy: number; zoom: number }
  | { kind: 'split'; top: { cx: number; cy: number; zoom: number }; bottom: { cx: number; cy: number; zoom: number } }
  | { kind: 'fit' }
  | { kind: 'stream'; cam: Rect; main: Rect };
export type EdlSegment = { srcStart: number; srcEnd: number; layout: Layout }; // seconds in hi-res file
export type EdlCaption = { start: number; end: number; words: Word[] };   // output-timeline seconds
export type Edl = {
  fps: 30; width: 1080; height: 1920; videoSrc: string; srcAspect: number;
  segments: EdlSegment[]; captions: EdlCaption[];
  hook: { text: string; start: number; end: number } | null; durationSec: number; style: string;
};

export type QcCheck = { name: string; ok: boolean; detail: string; severity: 'error' | 'warn' };
export type QcReport = { ok: boolean; checks: QcCheck[]; fixesApplied: string[]; at: string };

export type ClipStatus = 'planned' | 'rendered' | 'qc_failed' | 'ready' | 'approved' | 'rejected' | 'published';
export type Clip = {
  id: string; sourceId: string; creator: string; candidateId: string;
  start: number; end: number;                    // source seconds (after snapping, before cold open)
  coldOpen: { start: number; end: number } | null;
  title: string; description: string; hashtags: string[];
  hooks: Hook[]; hookIndex: number;
  scores: Scores; composite: number; rankReason: string; patterns: string[];
  hiresOffset: number;                            // source second at hi-res file t=0
  edl?: Edl; qc?: QcReport; status: ClipStatus;
  review?: { decision: 'approved' | 'rejected'; reason?: string; at: string };
  publish?: { videoId: string; publishAt?: string; privacy: string; at: string; dryRun: boolean };
  metrics?: { at: string; views: number; engagedViews?: number; avgViewPct?: number; avgViewSec?: number; source: 'analytics' | 'public' | 'csv' }[];
  plannedPublishAt?: string; error?: string;
  renders: number; createdAt: string; updatedAt: string;
};

export type LedgerEntry = { at: string; tier: string; model: string; purpose: string; costUsd: number; ms: number; cached: boolean };
```

---
### Task 1: Scaffold, config, store, process runner, binaries, doctor/setup

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, `src/types.ts` (verbatim from "Shared Types"), `src/config.ts`, `src/store.ts`, `src/log.ts`, `src/tools/proc.ts`, `src/tools/bins.ts`, `src/cli.ts`
- Test: `tests/store.test.ts`, `tests/proc.test.ts`

**Interfaces:**
- Produces:
  - `config.ts`: `ROOT: string`, `DATA: string` (= env `CB_DATA` or `ROOT/data`), `BIN: string` (`ROOT/bin`), `SECRETS: string` (`ROOT/.secrets`), `env(name: string, fallback?: string): string | undefined` (loads `ROOT/.env` once with a simple `KEY=VALUE` parser; `process.env` wins).
  - `store.ts`: `readJson<T>(p: string): T`, `readJsonOr<T>(p: string, d: T): T`, `writeJson(p: string, v: unknown): void` (mkdir -p, write `p.tmp` then rename), `appendJsonl(p: string, v: unknown): void`, `newId(prefix: string): string` (`prefix_` + 8 lowercase base36 chars from crypto), `paths` object: `paths.creator(slug)`, `paths.source(id)`, `paths.clip(id)` → absolute dirs under `DATA/creators|sources|clips`; `listDirs(dir: string): string[]`; `loadCreator(slug): Creator`, `saveCreator(c)`, `listCreators(): Creator[]`, `loadSource(id)`, `saveSource(s)`, `loadClip(id)`, `saveClip(c)` (sets `updatedAt`), `listClips(filter?: (c: Clip) => boolean): Clip[]` (sorted by `createdAt`).
  - `proc.ts`: `run(cmd: string, args: string[], opts?: { cwd?: string; input?: string; timeoutMs?: number; env?: Record<string,string>; shell?: boolean }): Promise<{ code: number; stdout: string; stderr: string }>` (never rejects on non-zero exit; rejects on spawn error/timeout), `runOk(...)` same signature but rejects with an Error containing the last 2000 chars of stderr when code≠0, `spawnStream(cmd, args, opts?)` returns the `ChildProcess` (for raw frame piping).
  - `bins.ts`: `ffmpeg(): string`, `ffprobe(): string`, `ytdlp(): string` (= `BIN/yt-dlp.exe`, throws "missing yt-dlp — run `cb setup`" if absent), `whisperDir(): string` (= `BIN/whisper.cpp`), `whisperModel(): string` (env `CB_WHISPER_MODEL` default `base.en`), `ultrafaceModel(): string` (= `BIN/models/ultraface-rfb-320.onnx`), `setup(): Promise<void>`, `doctor(): Promise<{ name: string; ok: boolean; detail: string }[]>`.
  - `cli.ts`: `parseArgs(argv: string[])` → `{ _: string[]; flags: Record<string, string | boolean> }` (`--k v`, `--k=v`, bare `--flag` = true); a `commands: Record<string, { help: string; run: (a: ParsedArgs) => Promise<void> }>` map; unknown/no command prints help. This task registers `doctor` and `setup`; every later task adds its commands to this same map.

- [ ] **Step 1: package.json + install**

```json
{
  "name": "clipbrain", "private": true, "version": "0.1.0", "type": "module",
  "scripts": { "cb": "tsx src/cli.ts", "test": "vitest run", "studio": "remotion studio remotion/index.ts" },
  "dependencies": {
    "remotion": "4.0.527", "@remotion/bundler": "4.0.527", "@remotion/renderer": "4.0.527", "@remotion/cli": "4.0.527",
    "@remotion/install-whisper-cpp": "4.0.527", "@remotion/google-fonts": "4.0.527",
    "react": "18.3.1", "react-dom": "18.3.1", "onnxruntime-node": "^1.20.0", "google-auth-library": "^9.15.0"
  },
  "devDependencies": { "typescript": "^5.6.0", "tsx": "^4.19.0", "vitest": "^2.1.0", "@types/node": "^22.0.0", "@types/react": "^18.3.0" }
}
```
Run `npm install` in the repo root → exit 0.

`tsconfig.json`: `{"compilerOptions":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","jsx":"react-jsx","strict":true,"esModuleInterop":true,"skipLibCheck":true,"resolveJsonModule":true,"allowImportingTsExtensions":false,"noEmit":true},"include":["src","remotion","tests"]}`
`vitest.config.ts`: `export default { test: { include: ['tests/**/*.test.ts'], testTimeout: 20000 } };`
`.env.example`: `CB_DATA=`, `FFMPEG_PATH=`, `FFPROBE_PATH=`, `CB_WHISPER_MODEL=base.en`, `CB_LLM_CONCURRENCY=3`, `CB_PUBLISH_DAILY_CAP=10` (one per line).

Imports inside `src/` use `.js` extensions (`import { x } from './store.js'`) — tsx resolves them to `.ts`.

- [ ] **Step 2: failing tests**

```ts
// tests/store.test.ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
process.env.CB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-'));
const store = await import('../src/store.js');
describe('store', () => {
  it('writes atomically and reads back', () => {
    const p = path.join(process.env.CB_DATA!, 'a/b/c.json');
    store.writeJson(p, { x: 1 });
    expect(store.readJson(p)).toEqual({ x: 1 });
    expect(fs.existsSync(p + '.tmp')).toBe(false);
  });
  it('readJsonOr returns default for missing file', () => {
    expect(store.readJsonOr(path.join(process.env.CB_DATA!, 'nope.json'), [])).toEqual([]);
  });
  it('newId has prefix and is unique', () => {
    const a = store.newId('clip'), b = store.newId('clip');
    expect(a).toMatch(/^clip_[a-z0-9]{8}$/); expect(a).not.toBe(b);
  });
});
```
```ts
// tests/proc.test.ts
import { it, expect } from 'vitest';
import { run, runOk } from '../src/tools/proc.js';
it('captures stdout and exit code', async () => {
  const r = await run(process.execPath, ['-e', 'process.stdout.write("hi");process.exit(3)']);
  expect(r).toMatchObject({ code: 3, stdout: 'hi' });
});
it('runOk throws with stderr on failure', async () => {
  await expect(runOk(process.execPath, ['-e', 'console.error("boom");process.exit(1)'])).rejects.toThrow(/boom/);
});
it('passes stdin', async () => {
  const r = await run(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'abc' });
  expect(r.stdout).toBe('abc');
});
```
Run `npx vitest run tests/store.test.ts tests/proc.test.ts` → FAIL (modules missing).

- [ ] **Step 3: implement `config.ts`, `store.ts`, `log.ts`, `proc.ts`** per Interfaces. `run` uses `child_process.spawn` with `windowsHide: true`, utf8 collection, writes `input` to stdin then ends it (always end stdin, even with no input), kills the process on timeout and rejects with `Error('timeout after Nms: cmd')`. `log.ts`: `log(...a)` prints `[HH:MM:SS] ...` to stderr; `step(name)` logs start and returns `done(extra?)` that logs elapsed seconds.

- [ ] **Step 4: implement `bins.ts`**
  - `ffmpeg()`: `env('FFMPEG_PATH')` if the file exists → `C:\Users\tomal\AppData\Local\Microsoft\WinGet\Links\ffmpeg.exe` if exists → `'ffmpeg'`. `ffprobe()` analogous with `FFPROBE_PATH`.
  - `setup()`:
    1. If `BIN/yt-dlp.exe` missing: `fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe')` (redirects followed) → write file; log size in MB.
    2. `installWhisperCpp({ to: whisperDir(), version: '1.5.5' })`, then `downloadWhisperModel({ model: whisperModel(), folder: whisperDir() })` (both from `@remotion/install-whisper-cpp`; both are no-ops when already present).
    3. If `ultrafaceModel()` missing: download `https://github.com/onnx/models/raw/main/validated/vision/body_analysis/ultraface/models/version-RFB-320.onnx`; on non-200 try `https://github.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB/raw/master/models/onnx/version-RFB-320.onnx`. Validate size > 500 KB.
  - `doctor()`: rows for node version, ffmpeg (first line of `-version`, and `-filters` contains `scdet`, `ebur128`, `blackdetect`, `freezedetect`, `silencedetect`, `loudnorm`), ffprobe, yt-dlp `--version`, whisper `main.exe` + `ggml-<model>.bin`, ultraface model, `claude --version` (use `shell: true`), free disk (`fs.statfsSync(DATA)` → GB; warn row not ok if < 5 GB), `DATA` writable.

- [ ] **Step 5: `cli.ts`** — entry point `npx tsx src/cli.ts <command> ...`. `doctor` prints `ok/FAIL  name  detail` rows and sets `process.exitCode = 1` if any fail. `setup` runs `setup()` then `doctor`.
- [ ] **Step 6: verify** `npx vitest run` → PASS; `npx tsx src/cli.ts setup` → downloads succeed; `npx tsx src/cli.ts doctor` → every row `ok`.
- [ ] **Step 7: commit** `git add -A; git commit -m "feat: scaffold, store, process runner, binaries, doctor/setup"`

---

### Task 2: Tiered LLM adapter (claude CLI) with cache + ledger

**Files:**
- Create: `src/llm/claude.ts`, `src/llm/llm.ts`
- Test: `tests/llm.test.ts`

**Interfaces:**
- Consumes: `run` (proc), `DATA`, `env`, `readJsonOr/writeJson/appendJsonl`.
- Produces:
  - `type Tier = 'fast' | 'balanced' | 'strong'`; `MODEL: Record<Tier, string> = { fast: 'haiku', balanced: 'sonnet', strong: 'opus' }`.
  - `type Backend = (req: { model: string; system: string; prompt: string; schema: object }) => Promise<{ output: unknown; costUsd: number }>`.
  - `claudeBackend: Backend` (claude.ts).
  - `llmJson<T>(req: { tier: Tier; purpose: string; system: string; prompt: string; schema: object; noCache?: boolean }): Promise<T>` (llm.ts).
  - `setBackend(b: Backend): void`, `ledgerSummary(): { calls: number; cached: number; costUsd: number; byPurpose: Record<string, { calls: number; costUsd: number }> }`.

- [ ] **Step 1: failing test** (fake backend; no real calls)

```ts
// tests/llm.test.ts
import { it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
process.env.CB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-'));
const { llmJson, setBackend, ledgerSummary } = await import('../src/llm/llm.js');
it('maps tier to model, caches identical requests, logs ledger', async () => {
  let calls = 0;
  setBackend(async (r) => { calls++; return { output: { echo: r.model }, costUsd: 0.01 }; });
  const req = { tier: 'fast' as const, purpose: 't', system: 's', prompt: 'p', schema: { type: 'object' } };
  expect(await llmJson(req)).toEqual({ echo: 'haiku' });
  expect(await llmJson(req)).toEqual({ echo: 'haiku' });
  expect(calls).toBe(1);
  const s = ledgerSummary();
  expect(s.calls).toBe(2); expect(s.cached).toBe(1); expect(s.costUsd).toBeCloseTo(0.01);
});
it('retries once when the backend throws', async () => {
  let n = 0;
  setBackend(async () => { if (n++ === 0) throw new Error('flaky'); return { output: { ok: true }, costUsd: 0 }; });
  expect(await llmJson({ tier: 'balanced', purpose: 't2', system: 's', prompt: 'x', schema: {} })).toEqual({ ok: true });
});
```
- [ ] **Step 2:** `npx vitest run tests/llm.test.ts` → FAIL.
- [ ] **Step 3: implement `claude.ts`**

```ts
import fs from 'node:fs'; import path from 'node:path';
import { run } from '../tools/proc.js'; import { DATA } from '../config.js';
import type { Backend } from './llm.js';
export const claudeBackend: Backend = async ({ model, system, prompt, schema }) => {
  const cwd = path.join(DATA, '.llm-sandbox'); fs.mkdirSync(cwd, { recursive: true });
  const args = ['-p', '--model', model, '--output-format', 'json', '--json-schema', JSON.stringify(schema),
    '--tools', '', '--safe-mode', '--no-session-persistence', '--strict-mcp-config', '--system-prompt', system];
  const r = await run('claude', args, { cwd, input: prompt, timeoutMs: 15 * 60_000 });
  let j: any;
  try { j = JSON.parse(r.stdout); } catch { throw new Error(`claude returned non-JSON (code ${r.code}): ${r.stdout.slice(0, 500)} ${r.stderr.slice(-500)}`); }
  if (j.is_error || j.subtype !== 'success') throw new Error(`claude error: ${j.subtype} ${String(j.result).slice(0, 500)}`);
  const output = j.structured_output ?? JSON.parse(j.result);
  return { output, costUsd: Number(j.total_cost_usd ?? 0) };
};
```
If spawning `claude` fails on Windows (ENOENT) resolve the absolute path once via `where claude` and use it. Passing the system prompt and schema as argv is fine up to ~30 KB; if a schema/system ever exceeds that, write them to a file in `cwd` and use `--system-prompt-file` (check `claude --help`).
- [ ] **Step 4: implement `llm.ts`**: cache dir `DATA/.llm-cache/<sha256>.json`; key = sha256(JSON.stringify({model, system, prompt, schema})). Semaphore with size `Number(env('CB_LLM_CONCURRENCY','3'))`. On backend error wait 3 s, retry once; second failure throws. Append a `LedgerEntry` to `DATA/ledger.jsonl` for every call (hit → `cached:true, costUsd:0`). `ledgerSummary()` aggregates the file.
- [ ] **Step 5:** tests → PASS.
- [ ] **Step 6: live smoke** — CLI `llm-smoke`: `llmJson({tier:'fast', purpose:'smoke', system:'You return JSON only.', prompt:'Return ok=true.', schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok']}, noCache:true})` and print the result + `ledgerSummary()`. CLI `ledger` prints `ledgerSummary()` as a table. Run `npx tsx src/cli.ts llm-smoke` → `{ ok: true }` and a cost > 0.
- [ ] **Step 7: commit** `feat: tiered LLM adapter over claude CLI with cache and ledger`

---

### Task 3: Text utilities — tokens, json3 subtitles, sentences

**Files:**
- Create: `src/text/tokens.ts`, `src/text/json3.ts`, `src/text/sentences.ts`
- Test: `tests/text.test.ts`

**Interfaces:**
- Produces:
  - `normalizeToken(w: string): string` — lowercase; remove `'` and `’`; replace every char not in `[a-z0-9]` with ''; returns '' for pure punctuation.
  - `type Tok = { tok: string; start: number; end: number }`; `tokenize(words: Word[]): Tok[]` — splits a Word on whitespace (sub-tokens share its span evenly), normalizes, drops empties.
  - `parseJson3(json: any): Word[]` — for each `events[i]` with `segs`: word start = `(tStartMs + (seg.tOffsetMs ?? 0))/1000`; skip segs whose trimmed `utf8` is empty; a seg with multiple words splits evenly until the next seg start; each word's `end` = next word's `start`, and the last word of an event ends at `min(next event start, tStartMs+dDurationMs)/1000`.
  - `buildSentences(words: Word[], opts?: { maxGap?: number; maxWords?: number }): Sentence[]` — split after a word whose trimmed text ends with `.`, `?` or `!` (optionally followed by `"`/`'`/`)`), or when the gap to the next word > `maxGap` (default 1.2 s), or when the sentence reaches `maxWords` (default 45). `text` = trimmed words joined with single spaces.
  - `textOf(words: Word[], w0: number, w1: number): string` (inclusive).

- [ ] **Step 1: failing tests**

```ts
// tests/text.test.ts
import { it, expect } from 'vitest';
import { normalizeToken, tokenize } from '../src/text/tokens.js';
import { parseJson3 } from '../src/text/json3.js';
import { buildSentences } from '../src/text/sentences.js';
it('normalizes tokens', () => {
  expect(normalizeToken(" Don't,")).toBe('dont'); expect(normalizeToken('—')).toBe(''); expect(normalizeToken('$10K')).toBe('10k');
});
it('tokenize splits multi-word entries', () => {
  expect(tokenize([{ w: 'hello there', start: 0, end: 1 }])).toEqual([
    { tok: 'hello', start: 0, end: 0.5 }, { tok: 'there', start: 0.5, end: 1 }]);
});
it('parses json3', () => {
  const j = { events: [
    { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'so' }, { utf8: ' the', tOffsetMs: 400 }, { utf8: ' point', tOffsetMs: 900 }] },
    { tStartMs: 3000, dDurationMs: 10, segs: [{ utf8: '\n' }] },
    { tStartMs: 3100, dDurationMs: 900, segs: [{ utf8: 'is' }] }] };
  const w = parseJson3(j);
  expect(w.map(x => x.w)).toEqual(['so', 'the', 'point', 'is']);
  expect(w[0]).toEqual({ w: 'so', start: 1, end: 1.4 });
  expect(w[2].end).toBeCloseTo(3.0); expect(w[3].end).toBeCloseTo(4.0);
});
it('builds sentences on punctuation and long gaps', () => {
  const w = [{ w: 'Hi.', start: 0, end: 0.3 }, { w: 'I', start: 0.4, end: 0.5 }, { w: 'win', start: 0.5, end: 0.8 },
             { w: 'then', start: 3, end: 3.2 }, { w: 'stop?', start: 3.2, end: 3.5 }];
  const s = buildSentences(w);
  expect(s.map(x => x.text)).toEqual(['Hi.', 'I win', 'then stop?']);
  expect(s[1]).toMatchObject({ id: 1, start: 0.4, end: 0.8, w0: 1, w1: 2 });
});
```
(Why `point` ends at 3.0: the `\n`-only event is skipped, so the next non-empty event starts at 3.1, and the word's own event ends at 1000+2000 ms = 3.0 → min = 3.0.)
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5: commit** `feat: text utilities (tokens, json3, sentences)`

---

### Task 4: yt-dlp wrapper

**Files:**
- Create: `src/yt/ytdlp.ts`
- Test: `tests/ytdlp.test.ts` (pure mapper) + live smoke via CLI

**Interfaces:**
- Consumes: `ytdlp()`, `ffmpeg()`, `run/runOk`, `parseJson3`, `readJsonOr/writeJson`, `DATA`.
- Produces:
  - `baseArgs(): string[]` = `['--js-runtimes', 'node', '--no-warnings', '--ffmpeg-location', path.dirname(ffmpeg())]` (omit the last pair when `ffmpeg()` is a bare name).
  - `mapFlatEntries(json: any, channelUrl: string): RefShort[]` (pure, exported).
  - `listChannel(url: string, tab: 'shorts' | 'videos', limit: number): Promise<RefShort[]>` — `yt-dlp <base> --flat-playlist -J --playlist-end <limit> <url>/<tab>` → `mapFlatEntries`. For `tab==='shorts'`, entries missing `uploadDate` get enriched one by one with `videoInfo` (sleep 1 s between; max `limit`). Cache the final list at `DATA/cache/list-<sha1(url|tab|limit)>.json` for 12 h.
  - `fetchSubs(videoId: string): Promise<Word[] | null>` — cache `DATA/cache/subs/<id>.json` (store `null` results too, as `{"none":true}`). Command: `yt-dlp <base> --skip-download --write-auto-subs --write-subs --sub-langs "en,en-orig,en-US,en-GB" --sub-format json3 -o "<tmp>/%(id)s.%(ext)s" https://www.youtube.com/watch?v=<id>`; prefer file `<id>.en.json3`, else any `<id>.en*.json3`; `parseJson3`; delete tmp.
  - `videoInfo(urlOrId: string)` → `{ id, title, durationSec, width, height, channel, channelUrl, uploadDate, views }` via `-J --no-playlist --skip-download`.
  - `downloadAudio(url: string, outWav: string): Promise<void>` — `-f bestaudio -o <tmp>/a.%(ext)s`, then `ffmpeg -y -i <that file> -ac 1 -ar 16000 -c:a pcm_s16le outWav`; delete tmp.
  - `downloadProxy(url: string, outMp4: string): Promise<void>` — `-f "bv*[height<=360][ext=mp4]/bv*[height<=360]/wv*" --remux-video mp4 -o outMp4`.
  - `downloadSection(url: string, start: number, end: number, outMp4: string): Promise<void>` — `-f "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b" --download-sections "*<start>-<end>" --force-keyframes-at-cuts --merge-output-format mp4 -o outMp4`.
- [ ] **Step 1: failing test**

```ts
// tests/ytdlp.test.ts
import { it, expect } from 'vitest';
import { mapFlatEntries } from '../src/yt/ytdlp.js';
it('maps flat playlist entries', () => {
  const c = 'https://www.youtube.com/@X';
  expect(mapFlatEntries({ entries: [
    { id: 'a', title: 'T', view_count: 10, duration: 31, upload_date: '20260101' },
    { id: 'b', title: 'U', view_count: null }] }, c)).toEqual([
    { id: 'a', title: 'T', views: 10, durationSec: 31, uploadDate: '20260101', channelUrl: c },
    { id: 'b', title: 'U', views: 0, durationSec: 0, uploadDate: '', channelUrl: c }]);
});
```
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: live smoke** — CLI `yt-smoke <channelUrl>` prints the first 3 shorts and the word count of the first short's subtitles. Run with `https://www.youtube.com/@TheDiaryOfACEO`. Expected: 3 rows with views > 0 and a word count > 20. If YouTube blocks requests (429 / "sign in to confirm"), use superpowers:systematic-debugging; do NOT pull cookies from the user's browser without asking the controller.
- [ ] **Step 6: commit** `feat: yt-dlp wrapper (listing, subtitles, downloads)`

---

### Task 5: Mining — alignment, features, performance, orchestrator

**Files:**
- Create: `src/mine/align.ts`, `src/mine/features.ts`, `src/mine/mine.ts`
- Test: `tests/align.test.ts`, `tests/features.test.ts`

**Interfaces:**
- Consumes: `tokenize`, `Tok`, `listChannel`, `fetchSubs`, `videoInfo`, store helpers.
- Produces:
  - `type EpisodeIndex = { eps: { id: string; toks: Tok[]; durationSec: number; words: Word[] }[]; map: Map<string, { e: number; p: number }[]> }`
  - `buildIndex(episodes: { id: string; words: Word[]; durationSec: number }[], maxPostings?: number): EpisodeIndex` (K = 5-token shingles; shingles with more than `maxPostings` (default 25) postings are dropped as boilerplate).
  - `alignShort(shortId: string, shortWords: Word[], idx: EpisodeIndex, opts?: { minHits?: number; minCoverage?: number }): Alignment | null`
  - `median(xs: number[]): number`, `perfScores(shorts: RefShort[], now: Date, minAgeDays?: number): Map<string, number>` — per `channelUrl` group, eligible = age ≥ `minAgeDays` (default 7) and views > 0 (shorts with empty `uploadDate` are eligible); value = `Math.log(views / median(eligible views of that group))`.
  - `shortFeatures(short: RefShort, al: Alignment, ep: { words: Word[]; durationSec: number }, perf: number, shortWords: Word[]): ShortFeatures`
  - `mineCreator(slug: string, opts: { shorts: number; episodes: number; include: string[] }): Promise<{ nShorts: number; withSubs: number; aligned: number; episodesIndexed: number }>` — writes `creators/<slug>/shorts.json`, `alignments.json`, `features.json`, `mine-report.json`.
  - CLI: `creator add <slug> --name <n> --channel <url> --permission "<text>" [--shorts-url <url>]... [--publish-channel <UC…>]`, `creator list`, `mine <slug> [--shorts 80] [--episodes 60] [--include id1,id2]`.

- [ ] **Step 1: failing tests**

```ts
// tests/align.test.ts
import { it, expect } from 'vitest';
import { buildIndex, alignShort } from '../src/mine/align.js';
const mk = (text: string, t0 = 0, dt = 0.5) => text.split(' ').map((w, i) => ({ w, start: t0 + i * dt, end: t0 + (i + 1) * dt }));
const epText = Array.from({ length: 400 }, (_, i) => `w${i}`).join(' ');
const idx = buildIndex([{ id: 'ep1', words: mk(epText), durationSec: 200 }, { id: 'ep2', words: mk(Array.from({ length: 300 }, (_, i) => `z${i}`).join(' ')), durationSec: 150 }]);
it('aligns a contiguous excerpt', () => {
  const short = mk(Array.from({ length: 40 }, (_, i) => `w${100 + i}`).join(' '));
  const a = alignShort('s1', short, idx)!;
  expect(a.episodeId).toBe('ep1');
  expect(a.segments).toHaveLength(1);
  expect(a.segments[0].srcStart).toBeCloseTo(50); expect(a.segments[0].srcEnd).toBeCloseTo(70);
  expect(a.coverage).toBeGreaterThan(0.95);
});
it('detects a cold open (later excerpt first)', () => {
  const words = [...Array.from({ length: 15 }, (_, i) => `w${300 + i}`), ...Array.from({ length: 40 }, (_, i) => `w${100 + i}`)];
  const a = alignShort('s2', mk(words.join(' ')), idx)!;
  expect(a.segments.length).toBe(2);
  expect(a.segments[0].srcStart).toBeGreaterThan(a.segments[1].srcStart);
});
it('returns null for unrelated text', () => {
  expect(alignShort('s3', mk(Array.from({ length: 40 }, (_, i) => `q${i}`).join(' ')), idx)).toBeNull();
});
```
```ts
// tests/features.test.ts
import { it, expect } from 'vitest';
import { median, perfScores, shortFeatures } from '../src/mine/features.js';
it('median', () => { expect(median([3, 1, 2])).toBe(2); expect(median([1, 2, 3, 4])).toBe(2.5); });
it('perf is log ratio to channel median, excluding young shorts', () => {
  const s = (id: string, views: number, uploadDate: string) => ({ id, title: id, views, uploadDate, durationSec: 30, channelUrl: 'c' });
  const m = perfScores([s('a', 100, '20260101'), s('b', 1000, '20260101'), s('c', 10000, '20260101'), s('d', 5, '20260922')], new Date('2026-09-23'));
  expect(m.get('b')).toBeCloseTo(0); expect(m.get('c')).toBeCloseTo(Math.log(10)); expect(m.has('d')).toBe(false);
});
it('features: cold open + position', () => {
  const words = Array.from({ length: 400 }, (_, i) => ({ w: `w${i}`, start: i * 0.5, end: i * 0.5 + 0.4 }));
  const f = shortFeatures({ id: 's', title: 'T', views: 10, uploadDate: '', durationSec: 28, channelUrl: 'c' },
    { shortId: 's', episodeId: 'e', coverage: 1, hits: 40, segments: [
      { shortStart: 0, shortEnd: 6, srcStart: 150, srcEnd: 156, tokens: 12 },
      { shortStart: 6, shortEnd: 28, srcStart: 50, srcEnd: 72, tokens: 44 }] },
    { words, durationSec: 200 }, 0.5, words.slice(0, 10));
  expect(f.coldOpen).toBe(true); expect(f.nSegments).toBe(2); expect(f.positionInEpisode).toBeCloseTo(0.25);
  expect(f.srcSpanSec).toBeCloseTo(28);
});
```
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: implement `align.ts`**
  - `key(toks, i) = toks.slice(i, i+5).map(t => t.tok).join(' ')`.
  - Collect hits `{i, e, p}` for every short shingle. Vote episodes by hit count; best episode needs `hits ≥ minHits` (default 6).
  - For the best episode, compute each hit's offset `o = p - i`. For each short position `i` with several postings, keep the posting whose offset has the most support (support = number of hits in the episode whose offset is within ±3 of it).
  - Chain kept hits (sorted by `i`) into segments: same segment while `|o - prevO| ≤ 3` and `i - prevI ≤ 7`; otherwise start a new segment. Drop segments with < 2 hits.
  - Segment ranges: short tokens `[i0, i1+4]`, episode tokens `[p0, p1+4]`; times from the respective `Tok.start/end`. `tokens = i1 + 5 - i0`.
  - `coverage` = (union of covered short token indices) / short token count; return null if `coverage < minCoverage` (default 0.25).
- [ ] **Step 4: implement `features.ts`**
  - `srcSpanSec` = Σ (srcEnd − srcStart). `nSegments`. `coldOpen` = `segments.length ≥ 2 && segments[0].srcStart > segments[1].srcStart + 1`.
  - `tightened` = (max srcEnd − min srcStart − srcSpanSec) > 2 && !coldOpen, or `nSegments ≥ 3` && !coldOpen.
  - `startsAfterPause`: earliest-in-source segment start `s`; find the last episode word ending before `s + 0.05`; true if `s - thatWord.end ≥ 0.4` or none exists.
  - `positionInEpisode` = min srcStart / ep.durationSec. `durationSec` = short.durationSec or last short word end.
  - `text` = first 150 short words joined; `contextBefore` = episode words with `start ∈ [minSrcStart − 20, minSrcStart)` joined.
- [ ] **Step 5: implement `mine.ts`** as specified (log progress every 10 items; skip shorts/episodes whose subs are null; always add `include` ids to the episode list via `videoInfo`; only episodes with `durationSec ≥ 900`). Add the `creator` and `mine` CLI commands.
- [ ] **Step 6:** unit tests PASS.
- [ ] **Step 7: live run**
  - `npx tsx src/cli.ts creator add doac --name "The Diary Of A CEO" --channel https://www.youtube.com/@TheDiaryOfACEO --permission "Creator publicly encourages clipping; attribution + link in every description"`
  - `npx tsx src/cli.ts mine doac --shorts 80 --episodes 60 --include Kl-I7sUcAOY`
  - Expected: report with `aligned ≥ 20`. If alignment rate < 25 %, investigate with superpowers:systematic-debugging (e.g. inspect one short's tokens vs episode tokens) before changing thresholds.
- [ ] **Step 8: commit** `feat: creator mining (short↔episode alignment, features, performance)`

---

### Task 6: Playbook — types, stats, distillation, prompt block

**Files:**
- Create: `src/playbook/playbook.ts`, `src/playbook/distill.ts`
- Test: `tests/playbook.test.ts`

**Interfaces:**
- Consumes: `ShortFeatures`, `llmJson`, `SIGNALS`, store.
- Produces:

```ts
export type Playbook = {
  creator: string; version: number; updatedAt: string; source: 'default' | 'mined';
  stats: { nShorts: number; nAligned: number; duration: Quartiles; topDuration: Quartiles; coldOpenRate: number; topColdOpenRate: number; tightenedRate: number; startsAfterPauseRate: number } | null;
  idealDurationSec: { min: number; max: number };
  principles: string[];
  hookPatterns: { id: string; name: string; description: string; examples: string[] }[];
  structures: { id: string; name: string; description: string }[];
  antiPatterns: string[];
  exemplars: { shortId: string; title: string; perf: number; why: string }[];
  weights: Record<SignalName, number>;
  ownResults: OwnResults | null;
};
export type Quartiles = { p25: number; median: number; p75: number };
export type OwnResults = { updatedAt: string; nPublished: number; nReviewed: number; findings: string[]; rejectionNotes: string[];
  buckets: { feature: string; value: string; n: number; meanPerf: number }[]; signalCorrelations: Partial<Record<SignalName, { rho: number; n: number }>> };
```
  - `defaultPlaybook(creator: string): Playbook` — `source:'default'`, `idealDurationSec {min:20,max:75}`, weights all 1, principles: `["The first sentence must make sense with zero prior context and create a question or tension within 3 seconds.", "One idea per clip: a claim, a story, or a framework — with its payoff included.", "End on the payoff or a punchline, never mid-explanation.", "Prefer specific numbers, stories and contrarian claims over generic advice.", "Cut setup that the viewer does not need; keep setup the payoff depends on."]`, hookPatterns: `[{id:'contrarian',...},{id:'number',...},{id:'story',...},{id:'question',...},{id:'stakes',...}]` each with a one-line description and no examples, structures `[{id:'claim-proof', ...},{id:'story-lesson',...},{id:'list',...}]`, antiPatterns: `["Starting with 'and', 'so', 'but' or a pronoun that refers to earlier context", "Clips that only make sense with the full episode", "Ending before the point lands"]`.
  - `computeStats(features: ShortFeatures[]): NonNullable<Playbook['stats']>` — top = features with perf ≥ upper tercile.
  - `loadPlaybook(slug): Playbook` (default if file missing), `savePlaybook(pb): void` (writes `playbook.json` + `playbook.md`).
  - `renderPlaybookMd(pb): string` — headings: `# Playbook — <creator> (v<version>)`, `## Stats`, `## Ideal duration`, `## Principles`, `## Hook patterns`, `## Structures`, `## Anti-patterns`, `## Exemplars`, `## Signal weights`, `## Own results`.
  - `playbookPromptBlock(pb): string` — compact text: principles (numbered), hook patterns as `- [id] name: description (e.g. "ex1")`, structures `- [id] …`, anti-patterns, `Ideal duration: min–max s`, own-results findings and last 10 rejection notes if present.
  - `distill(slug): Promise<Playbook>` (distill.ts) — reads `features.json`; requires ≥ 8 features (else throws "not enough aligned shorts"); picks top 12 by perf and bottom 8; LLM `balanced`, purpose `distill`; returns merged playbook with `source:'mined'`, `version = old.version + 1`, weights and ownResults preserved from the old playbook.
  - CLI: `playbook <slug> [--distill]` (print md; with `--distill` run distillation first).

Distill schema (pass as `schema`):
```ts
const S = { type: 'object', required: ['principles','hookPatterns','structures','antiPatterns','exemplars','idealDurationSec'], properties: {
  principles: { type: 'array', items: { type: 'string' }, maxItems: 10 },
  hookPatterns: { type: 'array', maxItems: 8, items: { type: 'object', required: ['id','name','description','examples'], properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, examples: { type: 'array', items: { type: 'string' }, maxItems: 3 } } } },
  structures: { type: 'array', maxItems: 6, items: { type: 'object', required: ['id','name','description'], properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' } } } },
  antiPatterns: { type: 'array', items: { type: 'string' }, maxItems: 10 },
  exemplars: { type: 'array', maxItems: 8, items: { type: 'object', required: ['shortId','why'], properties: { shortId: { type: 'string' }, why: { type: 'string' } } } },
  idealDurationSec: { type: 'object', required: ['min','max'], properties: { min: { type: 'number' }, max: { type: 'number' } } } } };
```
System prompt (distill): "You are a senior short-form editor reverse-engineering how a professional clip team cuts long-form podcast episodes into Shorts. You are given measured statistics and paired examples (the short's words, the words just before it in the episode, structural features, and performance relative to the channel median; perf>0 = above median). Infer the editorial rules that separate high performers from low performers. Be concrete and falsifiable; no generic advice that would apply to any channel. Pattern ids must be short kebab-case. Examples must be verbatim opening lines from the provided shorts. Exemplars must reference provided shortIds."
Prompt: the stats JSON, then for each example: `### <shortId> perf=<+0.83> dur=<31s> segments=<n> coldOpen=<bool> tightened=<bool> startsAfterPause=<bool> position=<0.42>\nTITLE: …\nBEFORE: …\nSHORT: …`.

- [ ] **Step 1: failing tests**

```ts
// tests/playbook.test.ts
import { it, expect } from 'vitest';
import { defaultPlaybook, computeStats, renderPlaybookMd, playbookPromptBlock } from '../src/playbook/playbook.js';
const f = (perf: number, dur: number, coldOpen: boolean) => ({ shortId: 'x' + perf, episodeId: 'e', title: 't', views: 1, perf, durationSec: dur, srcSpanSec: dur, nSegments: coldOpen ? 2 : 1, coldOpen, tightened: false, startsAfterPause: true, positionInEpisode: 0.5, text: '', contextBefore: '' });
it('computes stats with a top tercile', () => {
  const s = computeStats([f(-1, 20, false), f(0, 30, false), f(1, 40, true), f(2, 50, true), f(-2, 60, false), f(0.5, 35, false)]);
  expect(s.nAligned).toBe(6); expect(s.duration.median).toBeCloseTo(37.5); expect(s.topColdOpenRate).toBe(1); expect(s.coldOpenRate).toBeCloseTo(2 / 6);
});
it('renders markdown and prompt block', () => {
  const pb = defaultPlaybook('doac');
  expect(renderPlaybookMd(pb)).toContain('## Hook patterns');
  const b = playbookPromptBlock(pb); expect(b).toContain('[contrarian]'); expect(b).toContain('Ideal duration: 20–75 s');
});
```
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: live distill** `npx tsx src/cli.ts playbook doac --distill` → prints a playbook whose hook-pattern examples are verbatim DOAC lines. Read it critically: if it is generic, improve the prompt (more examples, force contrast between top and bottom) and re-run.
- [ ] **Step 6: commit** `feat: playbook model, stats and LLM distillation`

---

### Task 7: Ingest, transcription, silences

**Files:**
- Create: `src/ingest.ts`, `src/analyze/transcribe.ts`, `src/analyze/silences.ts`
- Test: `tests/ingest.test.ts`

**Interfaces:**
- Consumes: `videoInfo`, `downloadAudio`, `downloadProxy`, `ffmpeg/ffprobe`, `runOk`, `whisperDir`, `whisperModel`, `buildSentences`, store.
- Produces:
  - `ingest(input: string, creator: string): Promise<Source>` — first `loadCreator(creator)`; throw if the creator does not exist or `clippingPermission` is empty ("record the creator's clipping permission with `cb creator add`"). URL → YouTube (`videoId` from `videoInfo`), else local file (must exist; `ffprobe -v error -show_entries stream=width,height:format=duration -of json`). Idempotent: an existing source with the same `videoId`/`filePath` is returned. Writes `source.json`, `audio.wav` (16 kHz mono), `proxy.mp4` (≤360p, for local files: `ffmpeg -i f -an -vf scale=-2:360 -c:v libx264 -preset veryfast -crf 28 proxy.mp4`).
  - `wordsFromCaptions(caps: { text: string; startMs: number; endMs: number }[]): Word[]` (pure) — a caption whose text does not start with a space is appended to the previous word (sub-word token); texts trimmed; drop empty and bracketed non-speech like `[Music]`, `[BLANK_AUDIO]`.
  - `transcribeSource(id: string): Promise<Word[]>` — skips if `words.json` exists; `transcribe({ inputPath, whisperPath: whisperDir(), whisperCppVersion: '1.5.5', model: whisperModel(), tokenLevelTimestamps: true, printOutput: false, additionalArgs: ['-t', String(Math.max(2, os.cpus().length - 1))] })` then `toCaptions({ whisperCppOutput })`; writes `words.json` and `sentences.json` (`buildSentences`).
  - `parseSilencedetect(stderr: string): Silence[]` (pure), `detectSilences(id): Promise<Silence[]>` — `ffmpeg -hide_banner -i audio.wav -af silencedetect=noise=-35dB:d=0.35 -f null -` → `silences.json`.
  - CLI: `ingest <url|file> --creator <slug>` (prints source id), `transcribe <sourceId>`.
- [ ] **Step 1: failing tests** for `wordsFromCaptions` and `parseSilencedetect`:

```ts
// tests/ingest.test.ts
import { it, expect } from 'vitest';
import { wordsFromCaptions } from '../src/analyze/transcribe.js';
import { parseSilencedetect } from '../src/analyze/silences.js';
it('merges sub-word tokens and drops non-speech', () => {
  expect(wordsFromCaptions([{ text: ' Hor', startMs: 0, endMs: 200 }, { text: 'mozi', startMs: 200, endMs: 400 }, { text: ' [BLANK_AUDIO]', startMs: 400, endMs: 900 }, { text: ' says.', startMs: 900, endMs: 1200 }]))
    .toEqual([{ w: 'Hormozi', start: 0, end: 0.4 }, { w: 'says.', start: 0.9, end: 1.2 }]);
});
it('parses silencedetect', () => {
  const s = '[silencedetect @ 0x1] silence_start: 1.5\n[silencedetect @ 0x1] silence_end: 2.25 | silence_duration: 0.75\n[silencedetect @ 0x1] silence_start: 9\n';
  expect(parseSilencedetect(s)).toEqual([{ start: 1.5, end: 2.25 }]);
});
```
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: live** — `npx tsx src/cli.ts ingest https://www.youtube.com/watch?v=Kl-I7sUcAOY --creator doac` then `npx tsx src/cli.ts transcribe <id>`. Record wall time. Spot-check 3 random sentences against the video's YouTube captions (`fetchSubs`) — word overlap should be high. If base.en transcription is too slow (> 30 min for the episode) or poor, log it in the task report; do not silently switch models.
- [ ] **Step 6: commit** `feat: ingest, whisper.cpp transcription, silence detection`

---

### Task 8: Visual scan — frames, shots, faces, analyze orchestrator

**Files:**
- Create: `src/analyze/frames.ts`, `src/analyze/shots.ts`, `src/analyze/faces.ts`, `src/analyze/analyze.ts`
- Test: `tests/visual.test.ts`

**Interfaces:**
- Consumes: `ffmpeg`, `spawnStream`, `ultrafaceModel`, `transcribeSource`, `detectSilences`, store.
- Produces:
  - `readFrames(file: string, o: { fps: number; width: number; height: number; start?: number; duration?: number }): AsyncGenerator<{ t: number; rgb: Buffer }>` — `ffmpeg -hide_banner -loglevel error [-ss start] -i file [-t duration] -vf fps=<fps>,scale=<w>:<h> -f rawvideo -pix_fmt rgb24 pipe:1`; yields complete frames (`w*h*3` bytes), `t = (start ?? 0) + n / fps`.
  - `grayThumb(rgb: Buffer, w: number, h: number, tw = 64, th = 36): Uint8Array` (block-average luma), `frameDiff(a: Uint8Array, b: Uint8Array): number` (mean abs diff).
  - `detectShots(diffs: { t: number; d: number }[], durationSec: number, o?: { minShot?: number; floor?: number; k?: number }): Shot[]` — cut at `t` when `d > max(floor (default 14), k (default 4) × median of the previous 25 diffs)` and `t - lastCut ≥ minShot` (default 0.6). Returns contiguous shots covering `[0, durationSec]`.
  - `letterbox(rgb: Buffer, w: number, h: number): { data: Float32Array; padTop: number; contentH: number }` — input frame must already be 320 wide; output CHW float32 1×3×240×320 normalized `(v − 127) / 128`, black padding top/bottom.
  - `nms(boxes: FaceBox[], iou: number): FaceBox[]`.
  - `createFaceDetector(): Promise<(rgb: Buffer, w: number, h: number) => Promise<FaceBox[]>>` — onnxruntime-node session on `ultrafaceModel()`; input name `session.inputNames[0]`; outputs `scores` [1,N,2] (index 1 = face) and `boxes` [1,N,4] (x1,y1,x2,y2 normalized to the 320×240 input); keep score > 0.7; convert y from letterboxed space back to frame space (`(y*240 − padTop)/contentH`); clamp; NMS 0.3; return up to 8.
  - `analyzeSource(id: string, o?: { force?: boolean }): Promise<void>` — runs transcribe + silences, then ONE pass over `proxy.mp4` at 5 fps, 320×(320/aspect rounded to even): every frame → gray thumb → diff; every 5th frame → face detection. Writes `shots.json` (Shot[]) and `faces.json` (FaceSample[] at 1 fps). Logs progress each 10 % of duration.
  - CLI: `analyze <sourceId> [--force]`.
- [ ] **Step 1: failing tests**

```ts
// tests/visual.test.ts
import { it, expect } from 'vitest';
import { detectShots, frameDiff } from '../src/analyze/shots.js';
import { nms, letterbox } from '../src/analyze/faces.js';
it('detects hard cuts and ignores noise', () => {
  const diffs = Array.from({ length: 100 }, (_, i) => ({ t: (i + 1) * 0.2, d: i === 39 || i === 79 ? 60 : 3 + (i % 3) }));
  const shots = detectShots(diffs, 20.2);
  expect(shots.map(s => +s.start.toFixed(1))).toEqual([0, 8, 16]);
  expect(shots[shots.length - 1].end).toBeCloseTo(20.2);
});
it('frameDiff', () => { expect(frameDiff(new Uint8Array([0, 10]), new Uint8Array([10, 10]))).toBe(5); });
it('nms keeps the best of overlapping boxes', () => {
  const r = nms([{ x: 0, y: 0, w: 0.2, h: 0.2, score: 0.9 }, { x: 0.01, y: 0.01, w: 0.2, h: 0.2, score: 0.8 }, { x: 0.6, y: 0.6, w: 0.1, h: 0.1, score: 0.75 }], 0.3);
  expect(r.map(b => b.score)).toEqual([0.9, 0.75]);
});
it('letterboxes a 320x180 frame into 320x240', () => {
  const lb = letterbox(Buffer.alloc(320 * 180 * 3, 255), 320, 180);
  expect(lb.data.length).toBe(3 * 240 * 320); expect(lb.padTop).toBe(30); expect(lb.contentH).toBe(180);
  expect(lb.data[0]).toBeCloseTo(-127 / 128); expect(lb.data[320 * 100]).toBeCloseTo(1);
});
```
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: live** — `npx tsx src/cli.ts analyze <sourceId>`. Then CLI `faces-smoke <sourceId>` (add it) prints: number of shots, median shot length, % of 1-fps samples with ≥1 face, % with ≥2 faces, and writes 6 contact-sheet JPEGs (`ffmpeg -ss t -i proxy.mp4 -frames:v 1`) with face boxes listed alongside to `data/sources/<id>/debug/`. Open 2 of them with the Read tool to confirm boxes sit on faces. For a DOAC episode expect: many shots (multicam), faces in > 80 % of samples.
- [ ] **Step 6: commit** `feat: visual scan (shots, faces) and analyze orchestrator`

---

### Task 9: Selection — windows, proposal, snapping, dedupe, final ranking

**Files:**
- Create: `src/select/snap.ts`, `src/select/propose.ts`, `src/select/rank.ts`, `src/select/select.ts`
- Test: `tests/select.test.ts`

**Interfaces:**
- Consumes: `Sentence`, `Word`, `Candidate`, `Scores`, `SIGNALS`, `llmJson`, `loadPlaybook`, `playbookPromptBlock`, store, `newId`.
- Produces:
  - `windows(sentences: Sentence[], windowSec = 1200, overlapSec = 90): { s0: number; s1: number }[]` (inclusive sentence index ranges covering all sentences).
  - `snapBounds(sentences: Sentence[], words: Word[], startSid: number, endSid: number, pad = { start: 0.12, end: 0.3 }): { start: number; end: number }` — start = max(`sentences[startSid].start − pad.start`, end of the word before `w0` + 0.02, 0); end = min(`sentences[endSid].end + pad.end`, start of the word after `w1` − 0.02).
  - `composite(scores: Scores, weights: Record<SignalName, number>): number` (weighted mean, 2 decimals).
  - `dedupe(c: Candidate[], iou = 0.5): Candidate[]` — sort by composite desc; drop any candidate whose temporal IoU with a kept one ≥ `iou`.
  - `formatWindow(sentences: Sentence[], s0: number, s1: number): string` — lines `[<id>] (<m:ss>) <text>`.
  - `proposeWindow(ctx: { creatorName: string; pbBlock: string; minSec: number; maxSec: number }, sentences: Sentence[], w: { s0: number; s1: number }): Promise<RawCandidate[]>` where `RawCandidate = Omit<Candidate, 'id'|'sourceId'|'start'|'end'|'composite'|'shortlisted'|'rank'|'rankReason'>`.
  - `finalRank(cands: Candidate[], pbBlock: string, n: number): Promise<{ id: string; reason: string }[]>` (tier `strong`, purpose `rank`).
  - `selectSource(sourceId: string, o?: { top?: number; force?: boolean }): Promise<Candidate[]>` → writes `candidates.json`.
  - CLI: `select <sourceId> [--top 6] [--force]` prints a table: rank, mm:ss–mm:ss, duration, composite, title.

Proposal schema:
```ts
const scoreProp = { type: 'object', required: ['score', 'reason'], properties: { score: { type: 'number', minimum: 0, maximum: 10 }, reason: { type: 'string' } } };
export const PROPOSE_SCHEMA = { type: 'object', required: ['candidates'], properties: { candidates: { type: 'array', maxItems: 8, items: {
  type: 'object', required: ['startSid', 'endSid', 'title', 'summary', 'why', 'patterns', 'scores'], properties: {
    startSid: { type: 'integer' }, endSid: { type: 'integer' }, title: { type: 'string' }, summary: { type: 'string' }, why: { type: 'string' },
    patterns: { type: 'array', items: { type: 'string' } },
    scores: { type: 'object', required: SIGNALS, properties: Object.fromEntries(SIGNALS.map(s => [s, scoreProp])) } } } } } };
```
Proposal system prompt: "You are the head clip editor for <creatorName>. From a timestamped transcript window of a long-form episode, find moments that work as standalone vertical Shorts. Follow the channel playbook below — it was learned from this channel's own best and worst performing Shorts.\n\n<pbBlock>\n\nRules:\n- A clip is a contiguous range of sentence ids [startSid, endSid], duration between <minSec> and <maxSec> seconds (use the timestamps).\n- startSid must be understandable with zero prior context; never start on a sentence that refers back ('that', 'he', 'so', 'and' + earlier referent).\n- endSid must land the payoff; include the line where the point hits.\n- Return 0–8 candidates. Fewer, better candidates beat many weak ones. Return none if nothing in this window is genuinely strong.\n- Score each signal 0–10 with a one-line reason. Calibrate: 5 = an average clip on this channel, 8+ = top 10%, 10 = exceptional. Do not inflate.\n- patterns = ids of playbook hook patterns / structures the clip uses."
Prompt: `Episode: <title>\nTranscript window (sentence id, timestamp, text):\n<formatWindow>`.

Final-rank system prompt: "You pick the final Shorts to produce for <creatorName>. You see candidate clips (with per-signal scores from a first-pass editor who may be miscalibrated). Choose the <n> best, considering the playbook, variety of topics and hook patterns (do not pick near-duplicates of the same idea), and whether each would make a stranger stop scrolling. Return them best first with a one-sentence reason." Schema `{ ranking: [{ id: string, reason: string }] }` (maxItems n). Prompt lists each candidate: `id | m:ss–m:ss (Ns) | composite | title\nsummary\nwhy\nopening sentence: "…"\nscores: hook 7 (reason) · …`.

`selectSource` flow: load `sentences.json`, `words.json`, source, playbook (`loadPlaybook(source.creator)`); `minSec/maxSec` from `idealDurationSec`; run `proposeWindow` for every window concurrently (`Promise.all` — the LLM semaphore limits parallelism); validate each raw candidate (`s0 ≤ startSid ≤ endSid ≤ s1`, else drop); snap; drop if duration < minSec × 0.85 or > maxSec × 1.15; assign `id = newId('cand')`, composite; dedupe; take top 20 by composite → `finalRank` with `n = top` (default 6); set `rank`, `rankReason`, `shortlisted = true` for ranked ids; write all (sorted: shortlisted by rank, then others by composite).

- [ ] **Step 1: failing tests**

```ts
// tests/select.test.ts
import { it, expect } from 'vitest';
import { windows, snapBounds, composite, dedupe } from '../src/select/snap.js';
const sent = (id: number, start: number, end: number) => ({ id, text: 's' + id, start, end, w0: id * 2, w1: id * 2 + 1 });
const S = Array.from({ length: 100 }, (_, i) => sent(i, i * 30, i * 30 + 28));
const W = S.flatMap(s => [{ w: 'a', start: s.start, end: s.start + 10 }, { w: 'b.', start: s.start + 10, end: s.end }]);
it('windows cover everything with overlap', () => {
  const w = windows(S, 1200, 90);
  expect(w[0].s0).toBe(0); expect(w[w.length - 1].s1).toBe(99);
  for (let i = 1; i < w.length; i++) expect(w[i].s0).toBeLessThanOrEqual(w[i - 1].s1);
});
it('snaps to sentence bounds with padding but not into neighbours', () => {
  const b = snapBounds(S, W, 3, 4);
  expect(b.start).toBeCloseTo(89.88); expect(b.end).toBeCloseTo(148.3);
});
it('composite respects weights', () => {
  const sc: any = Object.fromEntries(['hook','standalone_clarity','payoff','novelty','emotional_intensity','information_density','audience_fit'].map((k, i) => [k, { score: i === 0 ? 10 : 5, reason: '' }]));
  const w: any = { hook: 3, standalone_clarity: 1, payoff: 1, novelty: 1, emotional_intensity: 1, information_density: 1, audience_fit: 1 };
  expect(composite(sc, w)).toBeCloseTo((30 + 30) / 9, 2);
});
it('dedupe keeps the higher composite of overlapping clips', () => {
  const c = (id: string, start: number, end: number, composite: number) => ({ id, start, end, composite }) as any;
  expect(dedupe([c('a', 0, 40, 6), c('b', 5, 45, 7), c('c', 100, 140, 5)]).map((x: any) => x.id)).toEqual(['b', 'c']);
});
```
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: live** `npx tsx src/cli.ts select <sourceId> --top 6`. Read the 6 shortlisted openings and endings (print the snapped text). If an opening depends on prior context or an ending stops before the payoff, that is a bug to investigate (prompt or snapping), not to ignore.
- [ ] **Step 6: commit** `feat: candidate selection (windows, proposal, snapping, dedupe, final ranking)`

---

### Task 10: Hooks, titles, cold-open choice

**Files:**
- Create: `src/hooks/hooks.ts`
- Test: `tests/hooks.test.ts`

**Interfaces:**
- Consumes: `llmJson`, `Playbook`, `playbookPromptBlock`, `Sentence`, `Hook`.
- Produces:
  - `generateHooks(input: { creatorName: string; episodeTitle: string; pb: Playbook; sentences: Sentence[]; startSid: number; endSid: number; candidateTitle: string; summary: string }): Promise<{ hooks: Hook[]; title: string; description: string; hashtags: string[]; coldOpenSid: number | null; coldOpenReason: string }>` (tier `balanced`, purpose `hooks`).
  - `validateColdOpen(sentences: Sentence[], startSid: number, endSid: number, sid: number | null): number | null` (pure) — valid only if `startSid < sid ≤ endSid` and sentence duration ≤ 7 s and ≥ 1.5 s; else null.
  - `sortHooks(h: Hook[]): Hook[]` (pure, score desc, stable; trims text; drops empty or > 70 chars).
- Schema: `{ hooks: [{ text, pattern, score }] (minItems 3, maxItems 5), title (string), description (string), hashtags (string[] maxItems 5), coldOpenSid (integer or null), coldOpenReason (string) }`.
- System prompt: "You write the on-screen hook text for a vertical Short cut from <creatorName>'s podcast. The hook is shown in the first ~3 seconds over the video; it must make a scrolling stranger stop, and it must be TRUE to what the clip actually says (no clickbait the clip does not pay off). Max 8 words, no emojis, no hashtags, sentence case. Write 5 hooks using different patterns from the playbook, score each 0–10 honestly for stopping power × accuracy. Also: a YouTube title (≤ 70 chars, may reuse the best hook), a 1–2 sentence description, up to 5 hashtags without '#'. Optionally choose ONE sentence id inside the clip (not the first) that would work as a cold open — a 2–7 s flash-forward of the most gripping line placed before the clip starts; return null if the clip's first line is already the strongest opening.\n\n<pbBlock>"
- Prompt: episode title, candidate title/summary, then the clip's sentences as `[id] (m:ss) text`.
- Description assembly is done in `produce` (Task 14), which appends the attribution line.

- [ ] **Step 1: failing tests** for `validateColdOpen` (valid inside; null for first sentence; null for > 7 s; null outside range) and `sortHooks` (order + filtering) with literal fixtures.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: commit** `feat: hook/title/cold-open generation`

---

### Task 11: Edit Decision List + crop planning (pure)

**Files:**
- Create: `src/edit/crop.ts`, `src/edit/edl.ts`
- Test: `tests/edl.test.ts`

`crop.ts` is also imported by the Remotion bundle (webpack), so it must have **no runtime imports** — only `import type { … } from '../types.js'` (type-only imports are erased).

**Interfaces:**
- Consumes: types only.
- Produces:
  - `cropRect(p: { cx: number; cy: number; zoom: number }, outAspect: number, srcAspect: number): Rect` — `h = 1/zoom`, `w = h * outAspect / srcAspect`; if `w > 1` then `w = 1, h = srcAspect / outAspect` (never exceed the frame); `x = clamp(cx − w/2, 0, 1 − w)`, `y = clamp(cy − h/2, 0, 1 − h)`.
  - `planLayout(samples: FaceSample[], srcAspect: number, override?: Layout): Layout`:
    - override → return it.
    - Faces considered: `score ≥ 0.7 && h ≥ 0.06`. Samples with ≥ 1 face = F. If `F.length === 0` → `{ kind: 'fit' }`.
    - `cropW = (9/16) / srcAspect`. For each sample in F take the two largest faces; the sample is "two-shot" if it has 2 faces whose center-x distance > `cropW * 0.8`.
    - If two-shot samples ≥ 50 % of F → split: left/right = median centers of the left-most / right-most of those pairs; `top = { cx: left.cx, cy: clamp(left.cy + 0.04, 0, 1), zoom: 1.6 }`, `bottom` likewise for right.
    - Else single: largest face per sample → median `cx`, median `cy`, median `h`. If median `h < 0.16` → `zoom = 1.35`, `cy = cyFace + 0.08`; else `zoom = 1`, `cy = 0.5`. Return `{ kind: 'face', cx, cy, zoom }`.
    - If the largest-face centers in F spread (max − min cx) > `cropW` and it is not a two-shot → `{ kind: 'fit' }` (a moving/unstable subject is safer shown whole).
  - `buildEdl(i: EdlInput): Edl` with
    ```ts
    export type EdlInput = { start: number; end: number; coldOpen: { start: number; end: number } | null; words: Word[]; shots: Shot[]; faces: FaceSample[];
      srcAspect: number; hiresOffset: number; videoSrc: string; hook: string | null; style: string; override?: Layout;
      opts?: { maxPause?: number; keepPause?: number; minSeg?: number; hookSec?: number } };
    ```
    Algorithm:
    1. Ranges: `coldOpen ? [coldOpen, {start,end}] : [{start,end}]`.
    2. Per range, words fully inside; split into speech runs wherever the gap between consecutive words > `maxPause` (0.45): run = `[prev run edge … ]` with `keepPause/2` (0.075) kept on each side of a cut; the first run starts at range.start, the last ends at range.end.
    3. Split runs at shot starts that fall inside them (> 0.3 s from either edge). Merge pieces shorter than `minSeg` (0.5 s) into their previous piece (or next if first) — merging means extending the neighbour and ignoring that shot cut.
    4. Layout per piece: `planLayout(faces with t in [shotOfPiece.start, shotOfPiece.end] (whole shot, for stability; if none, the 2 samples nearest the piece midpoint), srcAspect, override)`. Pieces in the same shot share one layout.
    5. Segments: `srcStart = piece.start − hiresOffset`, `srcEnd = piece.end − hiresOffset`.
    6. Output time map: piece k starts at Σ previous piece durations. Captions: each word inside a piece → output time (`outStart = pieceOut + (w.start − piece.start)`, same for end, clamped to the piece). Page words: up to 3 words; break early after a word ending `. ? ! ,` or if the next word starts > 0.3 s after this word ends. Page `start` = first word start, `end` = min(next page start, last word end + 0.4).
    7. `hook = text ? { text, start: 0, end: min(hookSec (3.2), durationSec) } : null`. Totals: `fps 30, width 1080, height 1920, durationSec = Σ pieces`.
- [ ] **Step 1: failing tests**

```ts
// tests/edl.test.ts
import { it, expect } from 'vitest';
import { cropRect, planLayout } from '../src/edit/crop.js';
import { buildEdl } from '../src/edit/edl.js';
const A = 16 / 9;
it('cropRect clamps to frame', () => {
  const r = cropRect({ cx: 0.02, cy: 0.5, zoom: 1 }, 9 / 16, A);
  expect(r.x).toBe(0); expect(r.h).toBe(1); expect(r.w).toBeCloseTo(0.3164, 3);
});
it('single face → face layout centred on the face', () => {
  const s = [0, 1, 2].map(t => ({ t, faces: [{ x: 0.6, y: 0.2, w: 0.1, h: 0.25, score: 0.95 }] }));
  expect(planLayout(s, A)).toMatchObject({ kind: 'face', cx: 0.65, zoom: 1 });
});
it('two separated faces → split', () => {
  const s = [0, 1, 2].map(t => ({ t, faces: [{ x: 0.1, y: 0.2, w: 0.1, h: 0.2, score: 0.9 }, { x: 0.75, y: 0.25, w: 0.1, h: 0.2, score: 0.9 }] }));
  const l = planLayout(s, A) as any;
  expect(l.kind).toBe('split'); expect(l.top.cx).toBeCloseTo(0.15); expect(l.bottom.cx).toBeCloseTo(0.8);
});
it('no faces → fit', () => { expect(planLayout([{ t: 0, faces: [] }], A)).toEqual({ kind: 'fit' }); });
const words = [
  { w: 'Hello', start: 10.0, end: 10.4 }, { w: 'world.', start: 10.4, end: 10.9 },
  { w: 'After', start: 12.0, end: 12.3 }, { w: 'pause', start: 12.3, end: 12.8 }, { w: 'end.', start: 12.8, end: 13.2 },
  { w: 'Payoff', start: 20.0, end: 20.5 }, { w: 'line.', start: 20.5, end: 21.0 }];
const base = { words, shots: [{ start: 0, end: 12.5 }, { start: 12.5, end: 60 }], faces: [{ t: 11, faces: [] }, { t: 13, faces: [] }],
  srcAspect: A, hiresOffset: 9, videoSrc: 'x.mp4', hook: 'Big hook', style: 'default' };
it('tightens long pauses and splits at shot cuts', () => {
  const e = buildEdl({ ...base, start: 9.9, end: 13.4, coldOpen: null });
  expect(e.segments.length).toBe(3);
  expect(e.segments[0].srcStart).toBeCloseTo(0.9);
  expect(e.segments[0].srcEnd).toBeCloseTo(10.975 - 9);
  expect(e.segments[1].srcStart).toBeCloseTo(11.925 - 9);
  expect(e.durationSec).toBeCloseTo((10.975 - 9.9) + (12.5 - 11.925) + (13.4 - 12.5), 3);
  expect(e.hook).toEqual({ text: 'Big hook', start: 0, end: 2.55 });
});
it('cold open comes first and captions are monotonic in output time', () => {
  const e = buildEdl({ ...base, start: 9.9, end: 13.4, coldOpen: { start: 19.9, end: 21.2 } });
  expect(e.segments[0].srcStart).toBeCloseTo(10.9);
  const starts = e.captions.map(c => c.start);
  expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  expect(e.captions[0].words.map(w => w.w)).toEqual(['Payoff', 'line.']);
  expect(e.captions[0].start).toBeCloseTo(0.1);
});
```
(Check of the first EDL test: range 9.9–13.4; gap 10.9→12.0 = 1.1 s > 0.45 → cut, keeping 0.075 each side: run1 = 9.9–10.975, run2 = 11.925–13.4; shot start 12.5 inside run2 → pieces 11.925–12.5 and 12.5–13.4; total = 1.075 + 0.575 + 0.9 = 2.55 → hook end = min(3.2, 2.55) = 2.55.)
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: commit** `feat: EDL builder with pause tightening, shot-aware reframing, captions`

---

### Task 12: Remotion template + renderer + loudness mastering

**Files:**
- Create: `remotion/index.ts`, `remotion/Root.tsx`, `remotion/Clip.tsx`, `remotion/VideoLayer.tsx`, `remotion/Captions.tsx`, `remotion/HookOverlay.tsx`, `remotion/style.ts`, `src/render/static.ts`, `src/render/render.ts`
- Test: `tests/render.test.ts`

**Interfaces:**
- Consumes: `Edl`, `cropRect` (import from `../src/edit/crop.js` inside remotion files), `downloadSection`, `ffmpeg/ffprobe`, `runOk`, store.
- Produces:
  - Remotion composition id `Clip`, props `{ edl: Edl }`, `calculateMetadata: ({ props }) => ({ durationInFrames: Math.max(1, Math.round(props.edl.durationSec * 30)) })`, `defaultProps` = a tiny valid EDL (so Studio opens).
  - `startStaticServer(root: string): Promise<{ url: string; close: () => Promise<void> }>` — 127.0.0.1, random port, serves files under `root` only (reject `..`), supports `Range` (206 + `Content-Range`), content types for mp4/jpg/json/html.
  - `ensureHires(clip: Clip, source: Source): Promise<void>` — window `[max(0, min(clip.start, coldOpen?.start ?? ∞) − 1), max(clip.end, coldOpen?.end ?? 0) + 1]`; reuse the existing `hires.mp4` if `clip.hiresOffset ≤ window.start` and its end covers `window.end`; YouTube → `downloadSection`; file → `ffmpeg -y -ss <s> -to <e> -i <file> -c:v libx264 -preset veryfast -crf 16 -c:a aac -b:a 192k hires.mp4`. Sets `clip.hiresOffset = window.start`. Verifies `ffprobe` duration within ±0.6 s of the window length, else throws.
  - `parseLoudnorm(stderr: string): { input_i: number; input_tp: number; input_lra: number; input_thresh: number; target_offset: number }` (pure; parses the last `{...}` JSON block).
  - `master(rawMp4: string, outMp4: string): Promise<void>` — 2-pass loudnorm to I −14, TP −1.0, LRA 11 (`linear=true`, measured values from pass 1), `-c:v copy -c:a aac -b:a 192k -ar 48000 -movflags +faststart`.
  - `renderClip(clipId: string): Promise<void>` — requires `clip.edl`; bundles `remotion/index.ts` once per process (`@remotion/bundler` `bundle({ entryPoint })`), static server over `DATA`, sets `inputProps.edl.videoSrc = <server>/clips/<id>/hires.mp4`, `selectComposition` + `renderMedia({ codec: 'h264', crf: 18, audioCodec: 'aac', pixelFormat: 'yuv420p', outputLocation: raw.mp4 })`, logs progress every 10 %, then `master(raw, render.mp4)`, poster `ffmpeg -y -ss 1.0 -i render.mp4 -frames:v 1 -vf scale=360:-2 poster.jpg`, deletes raw, `clip.renders++`, `status = 'rendered'`.
  - CLI: `render <clipId>`.

Remotion components (key code):

```tsx
// remotion/Clip.tsx
import { AbsoluteFill, Sequence } from 'remotion';
import type { Edl } from '../src/types';
import { VideoLayer } from './VideoLayer';
import { Captions } from './Captions';
import { HookOverlay } from './HookOverlay';
import { STYLES } from './style';
export const Clip: React.FC<{ edl: Edl }> = ({ edl }) => {
  const st = STYLES[edl.style] ?? STYLES.default;
  let acc = 0;
  const seqs = edl.segments.map((s, i) => {
    const from = Math.round(acc * edl.fps); acc += s.srcEnd - s.srcStart;
    const to = Math.round(acc * edl.fps);
    return <Sequence key={i} from={from} durationInFrames={Math.max(1, to - from)}>
      <VideoLayer src={edl.videoSrc} startFrom={Math.round(s.srcStart * edl.fps)} layout={s.layout} srcAspect={edl.srcAspect} frames={Math.max(1, to - from)} />
    </Sequence>;
  });
  return <AbsoluteFill style={{ backgroundColor: '#000' }}>{seqs}<Captions captions={edl.captions} st={st} />{edl.hook && <HookOverlay hook={edl.hook} st={st} />}</AbsoluteFill>;
};
```
```tsx
// remotion/VideoLayer.tsx — positions an OffthreadVideo so that a normalized crop rect fills a box
import { AbsoluteFill, OffthreadVideo, interpolate, useCurrentFrame } from 'remotion';
import { cropRect } from '../src/edit/crop';
import type { Layout, Rect } from '../src/types';
const Cropped: React.FC<{ src: string; startFrom: number; rect: Rect; boxW: number; boxH: number; srcAspect: number; muted?: boolean; volume?: (f: number) => number; style?: React.CSSProperties }> =
  ({ src, startFrom, rect, boxW, boxH, srcAspect, muted, volume, style }) => {
    const dispW = boxW / rect.w; const dispH = dispW / srcAspect;
    return <div style={{ position: 'absolute', width: boxW, height: boxH, overflow: 'hidden', ...style }}>
      <OffthreadVideo src={src} startFrom={startFrom} muted={muted} volume={volume}
        style={{ position: 'absolute', width: dispW, height: dispH, left: -rect.x * dispW, top: -rect.y * dispH, maxWidth: 'none' }} />
    </div>;
  };
export const VideoLayer: React.FC<{ src: string; startFrom: number; layout: Layout; srcAspect: number; frames: number }> = ({ src, startFrom, layout, srcAspect, frames }) => {
  const vol = (f: number) => interpolate(f, [0, 2, frames - 2, frames], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  if (layout.kind === 'face') return <Cropped src={src} startFrom={startFrom} rect={cropRect(layout, 1080 / 1920, srcAspect)} boxW={1080} boxH={1920} srcAspect={srcAspect} volume={vol} />;
  if (layout.kind === 'split') return <AbsoluteFill>
    <Cropped src={src} startFrom={startFrom} rect={cropRect(layout.top, 1080 / 960, srcAspect)} boxW={1080} boxH={960} srcAspect={srcAspect} volume={vol} />
    <Cropped src={src} startFrom={startFrom} rect={cropRect(layout.bottom, 1080 / 960, srcAspect)} boxW={1080} boxH={960} srcAspect={srcAspect} muted style={{ top: 960 }} />
    <div style={{ position: 'absolute', top: 956, width: 1080, height: 8, background: '#000' }} /></AbsoluteFill>;
  if (layout.kind === 'stream') return <AbsoluteFill>
    <Cropped src={src} startFrom={startFrom} rect={layout.cam} boxW={1080} boxH={768} srcAspect={srcAspect} volume={vol} />
    <Cropped src={src} startFrom={startFrom} rect={layout.main} boxW={1080} boxH={1152} srcAspect={srcAspect} muted style={{ top: 768 }} /></AbsoluteFill>;
  // fit: blurred cover background + full frame centred
  const fullH = 1080 / srcAspect;
  return <AbsoluteFill>
    <Cropped src={src} startFrom={startFrom} rect={cropRect({ cx: 0.5, cy: 0.5, zoom: 1 }, 1080 / 1920, srcAspect)} boxW={1080} boxH={1920} srcAspect={srcAspect} muted style={{ filter: 'blur(28px) brightness(0.55)', transform: 'scale(1.1)' }} />
    <Cropped src={src} startFrom={startFrom} rect={{ x: 0, y: 0, w: 1, h: 1 }} boxW={1080} boxH={fullH} srcAspect={srcAspect} volume={vol} style={{ top: (1920 - fullH) / 2 - 160 }} />
  </AbsoluteFill>;
};
```
For the stream layout, `cam`/`main` rects must have the box's aspect (the creator's `layoutOverride` is expected to be set accordingly; `Cropped` scales by width).
`Captions.tsx`: finds the page whose `[start, end)` contains `frame/fps`; renders its words uppercase, centred, at `top: st.captionTop` (default 1180 px), font `Montserrat` weight 900 (`loadFont` from `@remotion/google-fonts/Montserrat`), size 84 px, white with `WebkitTextStroke: '10px #000'`, `paintOrder: 'stroke fill'`, text-shadow; the word being spoken (`w.start ≤ t < w.end`) gets `st.accent` (default `#FFD84D`); page entry scale via `spring({ frame: frame − pageStartFrame, fps, config: { damping: 200 }, durationInFrames: 6 })` from 0.85 → 1.
`HookOverlay.tsx`: from `hook.start` to `hook.end`: white rounded box (radius 24, padding 28×40, max-width 940) at `top: 260`, black text 70 px weight 800 (Montserrat), spring-in over 8 frames, fade out over the last 6 frames.
`style.ts`: `export const STYLES: Record<string, { accent: string; captionTop: number; hookTop: number; font: string }> = { default: { accent: '#FFD84D', captionTop: 1180, hookTop: 260, font: 'Montserrat' } };`

- [ ] **Step 1: failing tests**

```ts
// tests/render.test.ts
import { it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { startStaticServer } from '../src/render/static.js';
import { parseLoudnorm } from '../src/render/render.js';
it('serves byte ranges', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-')); fs.writeFileSync(path.join(d, 'a.mp4'), Buffer.from('0123456789'));
  const s = await startStaticServer(d);
  const r = await fetch(`${s.url}/a.mp4`, { headers: { Range: 'bytes=2-5' } });
  expect(r.status).toBe(206); expect(await r.text()).toBe('2345'); expect(r.headers.get('content-range')).toBe('bytes 2-5/10');
  expect((await fetch(`${s.url}/../x`)).status).toBeGreaterThanOrEqual(400);
  await s.close();
});
it('parses loudnorm json', () => {
  const e = 'blah\n[Parsed_loudnorm_0 @ 0x]\n{\n"input_i" : "-20.51",\n"input_tp" : "-3.20",\n"input_lra" : "5.10",\n"input_thresh" : "-30.9",\n"target_offset" : "0.3"\n}\n';
  expect(parseLoudnorm(e)).toEqual({ input_i: -20.51, input_tp: -3.2, input_lra: 5.1, input_thresh: -30.9, target_offset: 0.3 });
});
```
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: live** — after Tasks 9–11 exist, create a clip by hand via CLI `render-test <sourceId>`: take the top candidate, `ensureHires`, `buildEdl` (hook = candidate title), save the clip, `renderClip`. Then `ffprobe render.mp4` (1080×1920, h264, aac) and extract 3 stills (`ffmpeg -ss t -i render.mp4 -frames:v 1 debug/still-N.jpg`) and look at them with the Read tool: face framed, captions readable, hook visible at t=1 s. Record render wall time.
- [ ] **Step 6: commit** `feat: Remotion clip template, renderer and loudness mastering`

---

### Task 13: Quality control — rules, measurements, auto-fix loop

**Files:**
- Create: `src/qc/rules.ts`, `src/qc/qc.ts`
- Test: `tests/qc.test.ts`

**Interfaces:**
- Consumes: `ffprobe/ffmpeg`, `run`, `readFrames`, `createFaceDetector`, `letterbox`, `cropRect`, `llmJson`, `buildEdl`, `renderClip`, `master`, `ensureHires`, store.
- Produces:
  - `type Measures = { probe: { width: number; height: number; vcodec: string; pixFmt: string; fps: number; acodec: string | null; durationSec: number }; loudness: { i: number; tp: number }; silences: Silence[]; black: { start: number; end: number }[]; freezes: { start: number; end: number }[]; faceChecks: { segment: number; ok: boolean }[]; content: { standalone: boolean; cleanEnding: boolean; hookMatches: boolean; issues: string[] } | null; maxCaptionChars: number }`
  - `evaluate(m: Measures, expectedDurationSec: number): QcCheck[]` (pure). Checks (name → rule → severity):
    - `resolution` 1080×1920 → error; `codec` h264 + yuv420p → error; `fps` |fps−30| < 0.01 → error; `audio` acodec === 'aac' → error; `duration` |dur − expected| ≤ 0.25 → error.
    - `loudness` −15.5 ≤ i ≤ −12.5 → error; `true_peak` tp ≤ −0.5 → error.
    - `dead_air` no silence ≥ 1.2 s → error. `black_frames` none ≥ 0.5 s → error. `frozen_video` none ≥ 2.5 s → warn.
    - `framing` if faceChecks non-empty: ≥ 60 % ok → else error.
    - `captions_length` maxCaptionChars ≤ 24 → warn.
    - content (if present): `standalone` → warn (humans judge), `clean_ending` → error, `hook_matches` → error, plus `content_issues` warn listing issues.
  - `measure(clip: Clip): Promise<Measures>` — ffprobe JSON; `ffmpeg -i render.mp4 -af ebur128=peak=true -f null -` (parse `I:` and `Peak:` from the Summary); `silencedetect=noise=-40dB:d=1.2`; `blackdetect=d=0.5:pix_th=0.10`; `freezedetect=n=0.003:d=2.5` (parse lavfi lines from stderr in one ffmpeg run with `-vf "blackdetect=…,freezedetect=…"` and `-af silencedetect=…`); face checks: for each EDL segment with `layout.kind === 'face'` and length ≥ 1 s, decode 1 frame at its output midpoint via `readFrames(render.mp4, { fps: 1, width: 134, height: 240, start: mid, duration: 0.05 })`, pillarbox it into a 320×240 black canvas (new pure helper `pillarbox(rgb, w, h): { data: Float32Array; padLeft: number; contentW: number }` in `faces.ts`, same normalization as `letterbox`; add a unit test), run the detector (extend `createFaceDetector` to accept a pre-built tensor + un-pad function), ok if any face centre-x maps into [0.2, 0.8] of the rendered frame width; content: tier `fast`, purpose `qc-content`, input = final hook + the caption words joined (output order).
  - `qcClip(clipId: string): Promise<QcReport>` — measure → evaluate → fixes (max 2 rounds), then `clip.qc = report`, `status = report.ok ? 'ready' : 'qc_failed'`. Fixes:
    - `loudness`/`true_peak` fail → re-run `master(raw.mp4, render.mp4)`. For this, `renderClip` keeps `raw.mp4` (it does NOT delete it); `qcClip` deletes `raw.mp4` when it finishes.
    - `clean_ending` fail → extend `clip.end` to the end of the next sentence if the new duration ≤ `maxSec × 1.15`, rebuild EDL (`ensureHires` again), re-render.
    - `hook_matches` fail → `hookIndex = next`, rebuild EDL, re-render.
    - `framing` fail → rebuild EDL with `layout = { kind: 'fit' }` for the failing segments, re-render.
    - `dead_air` fail → rebuild EDL with `maxPause: 0.3`, re-render.
    - `fixesApplied` lists what was done; `ok` = no error-severity failures.
  - The EDL rebuild logic lives in one helper `rebuildEdl(clip: Clip, overrides?: { maxPause?: number; fitSegments?: number[] }): Promise<void>` in `src/produce.ts` (Task 14) — this task implements it there if Task 14 is not done yet, and Task 14 reuses it.
  - CLI: `qc <clipId>` prints the check table.
- [ ] **Step 1: failing tests** — construct a passing `Measures` fixture and assert `evaluate` returns all ok; then mutate one field at a time (`width: 1920`, `loudness.i: -20`, a 1.5 s silence, `faceChecks` 1/3 ok, `content.cleanEnding=false`, `content.standalone=false`) and assert the named check fails with the right severity (standalone → warn, others → error).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: live** — `npx tsx src/cli.ts qc <clipId>` on the Task 12 test clip; confirm measurements are plausible (loudness near −14).
- [ ] **Step 6: commit** `feat: QC measurements, rules and auto-fix loop`

---

### Task 14: Produce, run, eval

**Files:**
- Create: `src/produce.ts`, `src/eval.ts`
- Modify: `src/cli.ts`
- Test: `tests/produce.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `attribution(source: Source, creator: Creator): string` (pure) → `"\n\nFrom \"<source.title>\" — <creator.name>\nFull episode: <source.url or ''>"`.
  - `planClip(source: Source, cand: Candidate, gen: Awaited<ReturnType<typeof generateHooks>>, sentences: Sentence[]): Clip` (pure) — status `planned`, `coldOpen` from `coldOpenSid` (`{start: s.start − 0.1, end: s.end + 0.2}` or null), `description = gen.description + attribution`, `hookIndex 0`, `renders 0`.
  - `rebuildEdl(clip, overrides?)` (see Task 13) — loads source words/shots/faces, calls `ensureHires`, then `buildEdl` with `hook = clip.hooks[clip.hookIndex]?.text ?? null`, `style = 'default'`, `override = creator.layoutOverride`, `videoSrc = 'hires.mp4'` (replaced at render time), `srcAspect = source.width / source.height`; for `fitSegments` it replaces those segments' layouts with `{ kind: 'fit' }` after building. Saves `clip.edl`.
  - `produceSource(sourceId: string, o?: { limit?: number }): Promise<Clip[]>` — for each shortlisted candidate (by rank) that has no clip yet: hooks → planClip → save → ensureHires → rebuildEdl → renderClip → qcClip. Each clip in its own try/catch: on error set `clip.error = message` and continue. Sequential (rendering is CPU-bound).
  - `runPipeline(input: string, creator: string, o: { top: number }): Promise<void>` — ingest → analyzeSource → selectSource → produceSource; prints a summary table (clip id, status, duration, composite, hook) and the ledger cost delta for this run, then `Review: npx tsx src/cli.ts review`.
  - `evalSource(sourceId: string): Promise<{ official: number; recall: number; precision: number; rows: { shortId: string; title: string; perf: number; srcStart: number; srcEnd: number; matchedCandidate: string | null; shortlisted: boolean }[] }>` (eval.ts) — official moments = alignments whose `episodeId === source.videoId`, span = min srcStart … max srcEnd of their segments; a candidate matches if temporal overlap / official span ≥ 0.3. `recall` over all candidates; `precision` = shortlisted candidates overlapping any official moment / shortlisted count. Prints a table and a caveat line: "Official shorts are one team's picks, not ground truth."
  - CLI: `produce <sourceId>`, `run <url|file> --creator <slug> [--top 6]`, `eval <sourceId>`, `clips [--status s]` (table).
- [ ] **Step 1: failing tests** for `attribution` and `planClip` (cold open from sentence id, description includes the attribution, status planned).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: live** — `npx tsx src/cli.ts produce <sourceId>` on the analysed DOAC episode (6 clips). Then `npx tsx src/cli.ts eval <sourceId>`.
- [ ] **Step 6: commit** `feat: produce/run pipeline and evaluation against official shorts`

---

### Task 15: Review server + UI + job queue

**Files:**
- Create: `src/review/server.ts`, `src/review/ui.html`
- Test: `tests/review.test.ts`

**Interfaces:**
- Consumes: store, `startStaticServer` range logic (reuse the handler: export `serveFile(req, res, root, relPath)` from `static.ts`), `rebuildEdl`, `renderClip`, `qcClip`, `ledgerSummary`, `loadPlaybook`.
- Produces:
  - `createReviewServer(o?: { port?: number }): Promise<{ url: string; close(): Promise<void> }>` (127.0.0.1 only; default port 4777).
  - API (JSON):
    - `GET /api/clips` → `Clip[]` minus `edl` (add `edlSummary: { segments: number; layouts: Record<string, number> }`), newest first, plus source title per clip.
    - `POST /api/clips/:id/approve` → requires status `ready` (or `qc_failed` with body `{ override: true }`); sets `review` + status `approved`.
    - `POST /api/clips/:id/reject` body `{ reason: string }` (reason required, non-empty) → status `rejected`.
    - `POST /api/clips/:id/hook` body `{ index: number }` → sets `hookIndex`, enqueues job `rerender` (rebuildEdl → renderClip → qcClip); returns `{ jobId }`.
    - `POST /api/clips/:id/title` body `{ title: string }` → updates title (≤ 100 chars).
    - `POST /api/clips/:id/schedule` body `{ publishAt: string | null }` → stored as `clip.plannedPublishAt` (ISO string or removed when null); rejected with 409 if the clip is already published. `publish` uses `plannedPublishAt` as `publishAt` when set and in the future.
    - `GET /api/jobs` → `{ id, clipId, kind, status: 'queued'|'running'|'done'|'error', error? }[]`.
    - `GET /api/summary` → counts by status + `ledgerSummary()`.
    - `GET /media/clips/:id/render.mp4|poster.jpg` → file with Range support.
    - `GET /` → `ui.html`.
  - Job queue: in-memory FIFO, one job at a time.
  - UI (`ui.html`, vanilla JS, no build): header with counts + LLM cost; filter tabs (Ready, QC failed, Approved, Rejected, Published, All); cards in a responsive grid: `<video controls preload="metadata" poster>` (9:16), title (editable input + save), rank + composite, the 7 signal bars with reasons on hover, "why" and rank reason, hook radio list (changing it calls `/hook` and shows the job state, polling `/api/jobs` every 2 s and reloading the video when done), QC checks list (✔/✖ with detail), source timestamps, buttons Approve / Reject (prompt for reason) / Override-approve (only for qc_failed). Every button calls the API and re-renders the card from the response — no dead controls.
  - CLI: `review [--port 4777]` (prints URL; keeps running).
- [ ] **Step 1: failing tests** — start the server on a temp `CB_DATA` with one fixture clip (status `ready`, no files); `POST approve` → 200 and status approved on disk; `POST reject` without reason → 400; `POST hook` → returns jobId (stub the job runner by exporting `setJobRunner(fn)` for tests); `GET /api/clips` returns the clip without `edl`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: live** — `npx tsx src/cli.ts review`, open `http://127.0.0.1:4777` in the built-in browser (`mcp__Claude_Browser__navigate`), screenshot, play a clip, switch a hook and watch the job complete, approve one clip, reject one with a reason; confirm on disk.
- [ ] **Step 6: commit** `feat: local review UI with approve/reject/hook re-render`

---

### Task 16: Publishing (YouTube), metrics, learning loop

**Files:**
- Create: `src/publish/oauth.ts`, `src/publish/youtube.ts`, `src/metrics/stats.ts`, `src/learn/learn.ts`
- Test: `tests/publish.test.ts`, `tests/learn.test.ts`

**Interfaces:**
- Consumes: store, `SECRETS`, `env`, `google-auth-library` (`OAuth2Client`), `publicStats`, `loadPlaybook/savePlaybook`, `SIGNALS`.
- Produces:
  - `oauth.ts`: `SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/yt-analytics.readonly']`; `authorize(): Promise<void>` — reads `.secrets/google-client.json` (Desktop-app OAuth client JSON downloaded by the user from Google Cloud Console; if missing, print step-by-step instructions and exit), starts a loopback server on `127.0.0.1:<random>`, prints + opens the consent URL (`access_type=offline`, `prompt=consent`), exchanges the code, saves `.secrets/youtube-token.json`. `getClient(): Promise<OAuth2Client | null>` (null when no token; refreshes automatically and persists refreshed tokens).
  - `youtube.ts`:
    - `buildUploadRequest(clip: Clip, o: { publishAt?: string }): { snippet: { title: string; description: string; tags: string[]; categoryId: '22' }; status: { privacyStatus: 'private'; publishAt?: string; selfDeclaredMadeForKids: false } }` (pure) — title ≤ 100 chars (append ` #shorts` only if it fits), description ≤ 4900 chars, tags from hashtags.
    - `eligibleForPublish(clips: Clip[], now: Date, dailyCap: number): { eligible: Clip[]; skipped: { id: string; reason: string }[] }` (pure) — only `status === 'approved'` with `qc.ok === true` (or an override recorded in `review.reason` starting with `override:`), not already published; cap = dailyCap minus clips published (non-dry-run) in the last 24 h.
    - `publish(o: { live: boolean; clipId?: string }): Promise<void>` — for each eligible clip: dry-run → print the request JSON and file path, record nothing; live → `getClient()` (error if null: "run `cb auth youtube`"), `GET https://www.googleapis.com/youtube/v3/channels?part=id&mine=true` → must equal `creator.publishChannelId` (error if unset or different), resumable upload (`POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status` with JSON body and headers `X-Upload-Content-Type: video/mp4`, `X-Upload-Content-Length`; then `PUT` the file bytes to the returned `Location`), store `clip.publish = { videoId, publishAt, privacy: 'private', at, dryRun: false }`, status `published`.
    - CLI: `auth youtube`, `publish [--live] [--clip <id>]`.
  - `stats.ts`: `collectStats(): Promise<number>` — published clips: if `getClient()` → YouTube Analytics `GET https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=2020-01-01&endDate=<today>&metrics=views,engagedViews,averageViewPercentage,averageViewDuration&dimensions=video&filters=video==<id1,id2,…>` (≤ 200 ids per call; if `engagedViews` is rejected, retry without it); else `publicStats(videoId)`. Appends a metrics snapshot per clip. `importCsv(path)` — columns `clipId,views,avgViewPct` (for manually posted TikTok/IG copies) → snapshots with `source:'csv'`. CLI: `stats`, `stats import <csv>`.
  - `learn.ts`:
    - `spearman(xs: number[], ys: number[]): number` (pure, average ranks for ties).
    - `outcomes(clips: Clip[], now: Date): { clip: Clip; perf: number }[]` (pure) — published clips whose publish date is ≥ 72 h old and that have metrics; outcome = ln(latest views / median latest views across those clips); if `avgViewPct` exists for all, outcome = 0.5·that + 0.5·z(avgViewPct).
    - `updateWeights(prior: Record<SignalName, number>, samples: { scores: Scores; y: number }[]): { weights: Record<SignalName, number>; correlations: Partial<Record<SignalName, { rho: number; n: number }>> }` (pure) — if n < 8 return prior unchanged; else per signal ρ = spearman(score, y); `w = clamp(1 + 2·ρ·n/(n + 20), 0.25, 3)`.
    - `buckets(rows: { clip: Clip; y: number }[]): OwnResults['buckets']` (pure) — features: `coldOpen` (yes/no), `duration` (<30, 30–45, 45–60, ≥60), `hookPattern` (hooks[hookIndex].pattern), `layout` (dominant layout kind); report only buckets with n ≥ 3.
    - `learn(slug: string): Promise<OwnResults>` — combine: published outcomes (y = perf) and review labels (approved = +1, rejected = −1) — the weight update uses published outcomes when n ≥ 8, otherwise review labels when n ≥ 8, otherwise unchanged; `rejectionNotes` = last 20 reject reasons; `findings` = plain-language lines generated deterministically from buckets with |meanPerf| ≥ 0.3 and n ≥ 5 (e.g. "Clips with cold opens: +0.42 vs median (n=7)"); saves into the playbook (`ownResults`, `weights`, version++).
    - CLI: `learn <slug>`.
- [ ] **Step 1: failing tests**
  - publish: `buildUploadRequest` title truncation + `#shorts` rule + private status; `eligibleForPublish` excludes non-approved, qc-failed, already-published, and enforces the cap.
  - learn: `spearman([1,2,3],[1,2,3]) = 1`, `spearman([1,2,3],[3,2,1]) = −1`; `updateWeights` returns prior for n = 5; with n = 20 where `hook` perfectly predicts y, `weights.hook ≈ 1 + 2·20/40 = 2` and uncorrelated signals ≈ 1; `buckets` filters n < 3.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: live** — `npx tsx src/cli.ts publish` (dry-run) prints requests for approved clips. `npx tsx src/cli.ts learn doac` runs on the review labels. Live upload is verified only if `.secrets/google-client.json` exists; otherwise report it as blocked on the user's Google OAuth client.
- [ ] **Step 6: commit** `feat: YouTube publishing with safeguards, metrics collection, learning loop`

---

### Task 17: README and end-to-end verification

**Files:**
- Create: `README.md`

- [ ] **Step 1: README** — what it is (one paragraph), architecture diagram (copy from spec §3), prerequisites, setup (`npm install`, `npx tsx src/cli.ts setup`, `doctor`), the full workflow with exact commands (creator add → mine → playbook --distill → run → review → publish → stats → learn), YouTube OAuth client setup steps, cost notes (ledger), safety notes (publish safeguards), data layout, known limitations.
- [ ] **Step 2: fresh E2E** — on a second real source (a different DOAC episode or a solo talking-head video from a clip-friendly creator), run `npx tsx src/cli.ts run <url> --creator doac --top 4` from scratch and confirm: every stage completes, clips reach `ready` or a justified `qc_failed`, review UI works, `publish` dry-run prints requests, `learn` runs.
- [ ] **Step 3: commit** `docs: README with setup and workflow`

import path from 'node:path';
import { DATA } from './config.js';
import { paths, loadSource, loadCreator, readJson, readJsonOr, saveClip, loadClip, listClips, listDirs, newId } from './store.js';
import { ensureHires, renderClip } from './render/render.js';
import { buildEdl } from './edit/edl.js';
import { qcClip } from './qc/qc.js';
import { generateHooks, type GeneratedHooks } from './hooks/hooks.js';
import { loadPlaybook } from './playbook/playbook.js';
import { ingest } from './ingest.js';
import { analyzeSource } from './analyze/analyze.js';
import { selectSource } from './select/select.js';
import { listChannel, canonicalWatchUrl } from './yt/ytdlp.js';
import { mmss } from './select/propose.js';
import { ledgerSummary } from './llm/llm.js';
import { isPublished } from './publish/state.js';
import { log, step } from './log.js';
import type { Clip, ClipStatus, Word, Shot, FaceSample, Source, Creator, Candidate, Sentence, RefShort, Silence } from './types.js';

// Task 14: hooks -> edl -> render -> qc orchestration for shortlisted candidates, plus the
// run/eval/scout entry points. `rebuildEdl` (below) predates this — it was needed by Task 13's
// QC auto-fix loop (see controller ruling R3 in task-13-brief.md) — and is left as-is.

/**
 * `"\n\nFrom \"<source.title>\" — <creator.name>\nFull episode: <source.url or ''>"` — appended
 * to every clip's LLM-generated description so viewers can find and credit the source episode.
 * Pure.
 */
export function attribution(source: Source, creator: Creator): string {
  // Canonical for YouTube sources, so a URL pasted from a playlist or share link (list=, t=, si=
  // tracking) never ends up in a public description — including sources ingested before
  // ingest() started storing the canonical form.
  const url = source.kind === 'youtube' && source.videoId ? canonicalWatchUrl(source.videoId) : (source.url ?? '');
  return `\n\nFrom "${source.title}" — ${creator.name}\nFull episode: ${url}`;
}

/**
 * Builds a freshly-planned (status `planned`) Clip from a shortlisted candidate and its
 * generated hooks — the first step of `produceSource`, before any hi-res fetch/EDL/render/QC
 * has happened. `renders` starts at 0 and `hookIndex` at 0 (the best-scored hook, since
 * `generateHooks`/`sortHooks` already sorted them descending). `coldOpen` is derived from
 * `gen.coldOpenSid` (already validated by `generateHooks`/`validateColdOpen`): the sentence's
 * own span padded -0.1s/+0.2s, or null when there is no cold open. `rank`/`why`/`visual`/
 * `boundary` are copied over from the candidate for the review UI (rendered defensively there).
 * Pure — no I/O, no id/clock inputs beyond `newId`/`Date.now` (same convention as other
 * id-minting constructors in this codebase, e.g. `select/snap.ts`'s `candidateId`).
 */
export function planClip(source: Source, creator: Creator, cand: Candidate, gen: GeneratedHooks, sentences: Sentence[]): Clip {
  const now = new Date().toISOString();
  const coldOpen =
    gen.coldOpenSid !== null
      ? { start: sentences[gen.coldOpenSid].start - 0.1, end: sentences[gen.coldOpenSid].end + 0.2 }
      : null;

  return {
    id: newId('clip'),
    sourceId: source.id,
    creator: source.creator,
    candidateId: cand.id,
    start: cand.start,
    end: cand.end,
    coldOpen,
    title: gen.title,
    description: gen.description + attribution(source, creator),
    hashtags: gen.hashtags,
    hooks: gen.hooks,
    hookIndex: 0,
    scores: cand.scores,
    composite: cand.composite,
    rankReason: cand.rankReason ?? '',
    patterns: cand.patterns,
    hiresOffset: 0,
    status: 'planned',
    renders: 0,
    createdAt: now,
    updatedAt: now,
    rank: cand.rank,
    why: cand.why,
    visual: cand.visual,
    boundary: cand.boundary,
  };
}

/**
 * Rebuilds a clip's EDL from its source's already-analyzed words/shots/faces, re-fetching hi-res
 * coverage first (`ensureHires`) in case `start`/`end`/`coldOpen` moved since the hi-res window
 * was last fetched. Used both by the initial hooks->edl step (future Task 14) and by QC's
 * auto-fix loop (Task 13), which mutates `clip.start`/`clip.end`/`clip.hookIndex` and then calls
 * this to regenerate the EDL to match before re-rendering.
 *
 * `overrides.maxPause` is forwarded to `buildEdl`'s own `opts.maxPause` (the dead_air fix loosens
 * pause-tightening). `overrides.fitSegments` replaces the *already-built* EDL's layout at those
 * segment indices with `{ kind: 'fit' }` (the framing / vision fit_layout fixes) — applied after
 * `buildEdl` runs, not fed into it, since `buildEdl` has no per-segment layout override of its own.
 */
export async function rebuildEdl(clip: Clip, overrides?: { maxPause?: number; fitSegments?: number[] }): Promise<void> {
  const source = loadSource(clip.sourceId);
  const creator = loadCreator(clip.creator);
  const dir = paths.source(clip.sourceId);
  const words = readJson<Word[]>(path.join(dir, 'words.json'));
  const shots = readJson<Shot[]>(path.join(dir, 'shots.json'));
  const faces = readJson<FaceSample[]>(path.join(dir, 'faces.json'));
  // Root-cause fix (2026-09-26, debug-dead-air.md): buildEdl also tightens real audio silences
  // (independent of whisper word timings, which can smear across one) — readJsonOr so a source
  // analyzed before silence detection existed still rebuilds (falls back to word-gaps only).
  const silences = readJsonOr<Silence[]>(path.join(dir, 'silences.json'), []);

  await ensureHires(clip, source);

  const hook = clip.hooks[clip.hookIndex]?.text ?? null;
  const edl = buildEdl({
    start: clip.start,
    end: clip.end,
    coldOpen: clip.coldOpen,
    words,
    shots,
    faces,
    silences,
    srcAspect: source.width / source.height,
    hiresOffset: clip.hiresOffset,
    videoSrc: 'hires.mp4',
    hook,
    style: clip.style ?? 'default',
    override: creator.layoutOverride,
    ...(overrides?.maxPause !== undefined ? { opts: { maxPause: overrides.maxPause } } : {}),
  });

  if (overrides?.fitSegments) {
    for (const idx of overrides.fitSegments) {
      if (edl.segments[idx]) edl.segments[idx] = { ...edl.segments[idx], layout: { kind: 'fit' } };
    }
  }

  clip.edl = edl;
  saveClip(clip);
}

/**
 * The pipeline stage functions `produceSource` calls, as an injectable seam for tests (real
 * production I/O — hi-res fetch, Remotion render, LLM calls — is far too slow/expensive to
 * exercise in a unit test). Defaults to the real implementations; a caller (or a test) can
 * override any subset via `produceSource`'s `o.deps`.
 */
export type ProduceDeps = {
  generateHooks: typeof generateHooks;
  ensureHires: typeof ensureHires;
  rebuildEdl: typeof rebuildEdl;
  renderClip: typeof renderClip;
  qcClip: typeof qcClip;
};

const defaultProduceDeps: ProduceDeps = { generateHooks, ensureHires, rebuildEdl, renderClip, qcClip };

/** A clip in one of these statuses is finished (successfully or not) — produceSource never
 * touches it again. Anything else (`planned`, `rendered`) is resumable. */
const TERMINAL_CLIP_STATUSES: ReadonlySet<ClipStatus> = new Set(['ready', 'qc_failed', 'approved', 'rejected', 'published']);

/**
 * For each shortlisted candidate (by rank), matched by `candidateId` against every existing clip
 * for this source:
 *   - no clip yet: hooks -> planClip -> save, then falls into the `planned` case below.
 *   - clip.status is `planned` or `rendered` (non-terminal — RESUMED from its last completed
 *     stage, once per call, whether or not `clip.error` is set from a prior failed attempt):
 *       - `planned`  -> ensureHires -> rebuildEdl -> renderClip -> qcClip (nothing durable yet).
 *       - `rendered` -> qcClip only (the render already succeeded).
 *   - clip.status is terminal (`ready`, `qc_failed`, `approved`, `rejected`, `published`):
 *     skipped — already finished, one way or another.
 * Sequential, not parallel: rendering is CPU-bound (Remotion + ffmpeg), so producing candidates
 * concurrently would just contend for the same cores rather than finishing faster.
 *
 * Each candidate is processed in its own try/catch: on error, the clip (if one exists on disk —
 * either just planned, or resumed) gets `clip.error = message` and is saved as-is. If hook
 * generation itself failed (no clip was ever created), the candidate still appears in the
 * returned results with the error — as an unsaved, synthetic Clip (never written via `saveClip`,
 * so the next `produceSource` call retries it fresh) — rather than vanishing silently. Either way
 * the loop continues to the next candidate rather than aborting the whole run. `o.limit`, when
 * given, caps how many candidates this call *works on* this call (skipped/terminal candidates
 * don't count against it; a resumed one does, same as a freshly-created one).
 */
export async function produceSource(sourceId: string, o?: { limit?: number; deps?: Partial<ProduceDeps> }): Promise<Clip[]> {
  const deps: ProduceDeps = { ...defaultProduceDeps, ...o?.deps };
  const dir = paths.source(sourceId);
  const source = loadSource(sourceId);
  const creator = loadCreator(source.creator);
  const pb = loadPlaybook(source.creator);
  const sentences = readJson<Sentence[]>(path.join(dir, 'sentences.json'));
  const candidates = readJson<Candidate[]>(path.join(dir, 'candidates.json'));
  const shortlisted = candidates.filter((c) => c.shortlisted).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));

  const existingByCandidateId = new Map(listClips((c) => c.sourceId === sourceId).map((c) => [c.candidateId, c]));

  const results: Clip[] = [];
  let produced = 0;
  for (const cand of shortlisted) {
    const existing = existingByCandidateId.get(cand.id);
    if (existing && TERMINAL_CLIP_STATUSES.has(existing.status)) continue;
    if (o?.limit !== undefined && produced >= o.limit) break;
    produced++;

    let clip: Clip | undefined = existing;
    try {
      if (!clip) {
        const gen = await deps.generateHooks({
          creatorName: creator.name,
          episodeTitle: source.title,
          pb,
          sentences,
          startSid: cand.startSid,
          endSid: cand.endSid,
          candidateTitle: cand.title,
          summary: cand.summary,
        });
        clip = planClip(source, creator, cand, gen, sentences);
        saveClip(clip);
      } else if (clip.error) {
        // Resuming after a prior failed attempt — clear the stale error so a successful resume
        // doesn't leave it lingering on the clip.
        delete clip.error;
        saveClip(clip);
      }

      if (clip.status === 'planned') {
        const doneHires = step(`produceSource ${sourceId}: ensureHires (${clip.id}, rank ${cand.rank})`);
        await deps.ensureHires(clip, source);
        doneHires();

        await deps.rebuildEdl(clip);

        const doneRender = step(`produceSource ${sourceId}: render (${clip.id})`);
        await deps.renderClip(clip.id);
        doneRender();

        const doneQc = step(`produceSource ${sourceId}: qc (${clip.id})`);
        await deps.qcClip(clip.id);
        doneQc();
      } else if (clip.status === 'rendered') {
        const doneQc = step(`produceSource ${sourceId}: qc (resumed, ${clip.id})`);
        await deps.qcClip(clip.id);
        doneQc();
      }

      results.push(loadClip(clip.id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`produceSource ${sourceId}: candidate ${cand.id} (rank ${cand.rank}) failed: ${message}`);
      if (clip) {
        // Reload from disk rather than reusing the in-memory `clip` object: renderClip/qcClip
        // load and save their own copy by id, so if either of them ran (and persisted a status
        // change) before something later in the try block threw, our local reference is stale —
        // saving it here would silently revert that already-persisted status.
        let onDisk: Clip;
        try {
          onDisk = loadClip(clip.id);
        } catch {
          onDisk = clip;
        }
        onDisk.error = message;
        saveClip(onDisk);
        results.push(onDisk);
      } else {
        // Hook generation itself failed before any clip existed — nothing to load/save, but the
        // candidate must still surface in the summary with its error rather than disappear.
        const now = new Date().toISOString();
        results.push({
          id: newId('clip'),
          sourceId: source.id,
          creator: source.creator,
          candidateId: cand.id,
          start: cand.start,
          end: cand.end,
          coldOpen: null,
          title: cand.title,
          description: '',
          hashtags: [],
          hooks: [],
          hookIndex: 0,
          scores: cand.scores,
          composite: cand.composite,
          rankReason: cand.rankReason ?? '',
          patterns: cand.patterns,
          hiresOffset: 0,
          status: 'planned',
          error: message,
          renders: 0,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }
  return results;
}

/**
 * Rebuilds a single clip's EDL with whatever `buildEdl`/`rebuildEdl` logic is current (e.g. the
 * silence-aware pause tightening fix) and re-runs render + QC — how a clip that previously failed
 * QC gets re-verified after a code fix, without re-doing hook generation or hi-res fetch (both
 * already succeeded the first time). Clears any stale `clip.error` first.
 */
export async function requalifyClip(clipId: string, deps?: Partial<ProduceDeps>): Promise<Clip> {
  const d: ProduceDeps = { ...defaultProduceDeps, ...deps };
  const clip = loadClip(clipId);
  // Re-rendering resets the status, which would pull a published clip back into review (and from
  // there towards a second upload) while overwriting the local copy of what is on YouTube.
  if (isPublished(clip)) throw new Error(`requalify: clip ${clipId} is already published — refusing to re-render it`);
  if (clip.error) {
    delete clip.error;
    saveClip(clip);
  }

  await d.rebuildEdl(clip);

  const doneRender = step(`requalifyClip ${clipId}: render`);
  await d.renderClip(clipId);
  doneRender();

  const doneQc = step(`requalifyClip ${clipId}: qc`);
  await d.qcClip(clipId);
  doneQc();

  return loadClip(clipId);
}

/**
 * Requalifies every clip of `sourceId` currently in `status` (e.g. `qc_failed`) — see
 * `requalifyClip`. Each clip is processed in its own try/catch, same failure-surfacing convention
 * as `produceSource`: on error, `clip.error` is set and saved, and the loop continues.
 */
export async function requalifySource(sourceId: string, status: ClipStatus, deps?: Partial<ProduceDeps>): Promise<Clip[]> {
  if (status === 'published') throw new Error('requalify: refusing to re-render published clips');
  const targets = listClips((c) => c.sourceId === sourceId && c.status === status);
  const results: Clip[] = [];
  for (const c of targets) {
    try {
      results.push(await requalifyClip(c.id, deps));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`requalifySource ${sourceId}: clip ${c.id} failed: ${message}`);
      let onDisk: Clip;
      try {
        onDisk = loadClip(c.id);
      } catch {
        onDisk = c;
      }
      onDisk.error = message;
      saveClip(onDisk);
      results.push(onDisk);
    }
  }
  return results;
}

/**
 * Full pipeline for one input: ingest -> analyzeSource -> selectSource -> produceSource. Prints a
 * summary table (clip id, status, source window, duration, composite, hook) and the ledger cost
 * delta incurred by this call (ingest/analyze/select/produce can all make LLM calls), then a
 * pointer to the review UI.
 */
export async function runPipeline(input: string, creator: string, o: { top: number }): Promise<void> {
  const before = ledgerSummary();

  const source = await ingest(input, creator);
  await analyzeSource(source.id);
  await selectSource(source.id, { top: o.top });
  const clips = await produceSource(source.id);

  const after = ledgerSummary();
  const deltaUsd = after.costUsd - before.costUsd;

  console.log(`\n${source.id} — ${source.title}`);
  console.log(
    'id'.padEnd(14),
    'status'.padEnd(11),
    'window'.padEnd(20),
    'dur'.padEnd(8),
    'composite'.padEnd(10),
    'hook',
  );
  for (const c of clips) {
    const window = `${mmss(c.start)}–${mmss(c.end)}`;
    const dur = c.edl ? `${c.edl.durationSec.toFixed(1)}s` : '-';
    const hook = c.error ? `ERROR: ${c.error}` : c.hooks[c.hookIndex]?.text ?? '(no hook)';
    console.log(
      c.id.padEnd(14),
      c.status.padEnd(11),
      window.padEnd(20),
      dur.padEnd(8),
      c.composite.toFixed(2).padEnd(10),
      hook,
    );
  }
  console.log(`\nledger cost this run: $${deltaUsd.toFixed(4)}`);
  console.log('\nReview: npx tsx src/cli.ts review');
}

/**
 * Pure filter for `scout`: keeps episodes at least `minDur` seconds long (default 900s = 15min,
 * so YouTube Shorts and short clips already on the channel don't come back as "episodes") whose
 * videoId isn't already in `existingVideoIds`, then takes the first `latest`. The input list is
 * assumed to already be newest-first (yt-dlp's channel "videos" tab listing order), so this does
 * no independent re-sort.
 */
export function pickNewEpisodes(list: RefShort[], existingVideoIds: Set<string>, latest: number, minDur = 900): RefShort[] {
  return list.filter((e) => e.durationSec >= minDur && !existingVideoIds.has(e.id)).slice(0, latest);
}

function existingVideoIdsForCreator(slug: string): Set<string> {
  const dir = path.join(DATA, 'sources');
  const ids = new Set<string>();
  for (const id of listDirs(dir)) {
    const s = readJsonOr<Source | null>(path.join(paths.source(id), 'source.json'), null);
    if (s && s.creator === slug && s.kind === 'youtube' && s.videoId) ids.add(s.videoId);
  }
  return ids;
}

/**
 * Automatic episode discovery (Task 14 extension): lists a creator's newest long-form episodes
 * (the `videos` tab, over-fetching `latest x 3` so there's headroom left after filtering) and
 * returns up to `latest` video URLs — newest first — that are long enough to be episodes (not
 * Shorts) and don't already have a source ingested for that videoId.
 */
export async function scout(slug: string, o?: { latest?: number; minDurationSec?: number }): Promise<string[]> {
  const latest = o?.latest ?? 3;
  const minDurationSec = o?.minDurationSec ?? 900;
  const creator = loadCreator(slug);
  const list = await listChannel(creator.channelUrl, 'videos', latest * 3);
  const existing = existingVideoIdsForCreator(slug);
  const picked = pickNewEpisodes(list, existing, latest, minDurationSec);
  return picked.map((e) => canonicalWatchUrl(e.id));
}

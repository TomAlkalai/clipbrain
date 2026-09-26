import path from 'node:path';
import { paths, loadSource, loadCreator, readJson, saveClip } from './store.js';
import { ensureHires } from './render/render.js';
import { buildEdl } from './edit/edl.js';
import type { Clip, Word, Shot, FaceSample } from './types.js';

// Task 14 (hooks -> edl -> render -> qc orchestration for shortlisted candidates) extends this
// file. For now it holds only `rebuildEdl`, needed by Task 13's QC auto-fix loop (see
// controller ruling R3 in task-13-brief.md).

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

  await ensureHires(clip, source);

  const hook = clip.hooks[clip.hookIndex]?.text ?? null;
  const edl = buildEdl({
    start: clip.start,
    end: clip.end,
    coldOpen: clip.coldOpen,
    words,
    shots,
    faces,
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

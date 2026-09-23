import path from 'node:path';
import { paths, loadCreator, writeJson } from '../store.js';
import { listChannel, fetchSubs, videoInfo } from '../yt/ytdlp.js';
import { buildIndex, alignShort } from './align.js';
import { perfScores, shortFeatures } from './features.js';
import { log, step } from '../log.js';
import type { RefShort, Alignment, ShortFeatures, Word } from '../types.js';

// Distinguishes full episodes from shorts/trailers/clips that may also appear on the "videos" tab.
const MIN_EPISODE_DURATION_SEC = 900;
const PROGRESS_EVERY = 10;

export type MineOpts = { shorts: number; episodes: number; include: string[] };
export type MineResult = { nShorts: number; withSubs: number; aligned: number; episodesIndexed: number };

function progress(label: string, i: number, n: number): void {
  if ((i + 1) % PROGRESS_EVERY === 0 || i + 1 === n) log(`${label}: ${i + 1}/${n}`);
}

export async function mineCreator(slug: string, opts: MineOpts): Promise<MineResult> {
  const creator = loadCreator(slug);
  const dir = paths.creator(slug);

  const doneShorts = step(`listing shorts for ${slug}`);
  const shorts = await listChannel(creator.channelUrl, 'shorts', opts.shorts);
  doneShorts(`${shorts.length} shorts`);
  writeJson(path.join(dir, 'shorts.json'), shorts);

  const doneEpisodes = step(`listing episodes for ${slug}`);
  const episodeEntries = await listChannel(creator.channelUrl, 'videos', opts.episodes);
  doneEpisodes(`${episodeEntries.length} videos`);

  const episodeMap = new Map<string, RefShort>();
  for (const e of episodeEntries) episodeMap.set(e.id, e);

  // Explicit includes are fetched individually so a specific episode (e.g. a fixture used by later
  // tasks) can be pulled in even if it has aged out of the most-recent-N "videos" tab listing.
  for (const id of opts.include) {
    try {
      const info = await videoInfo(id);
      episodeMap.set(id, {
        id: info.id,
        title: info.title,
        views: info.views,
        uploadDate: info.uploadDate,
        durationSec: info.durationSec,
        channelUrl: info.channelUrl || creator.channelUrl,
      });
    } catch (err) {
      log(`videoInfo failed for included episode ${id}:`, err instanceof Error ? err.message : String(err));
    }
  }

  const candidateEpisodes = [...episodeMap.values()].filter((e) => e.durationSec >= MIN_EPISODE_DURATION_SEC);

  const episodesForIndex: { id: string; words: Word[]; durationSec: number }[] = [];
  let episodesNoSubs = 0;
  for (let i = 0; i < candidateEpisodes.length; i++) {
    const e = candidateEpisodes[i];
    const words = await fetchSubs(e.id);
    progress('episode subs', i, candidateEpisodes.length);
    if (!words) {
      episodesNoSubs++;
      continue;
    }
    episodesForIndex.push({ id: e.id, words, durationSec: e.durationSec });
  }

  const doneIndex = step('building shingle index');
  const idx = buildIndex(episodesForIndex);
  doneIndex(`${episodesForIndex.length} episodes indexed`);

  const perf = perfScores(shorts, new Date());

  const alignments: Alignment[] = [];
  const features: ShortFeatures[] = [];
  let withSubs = 0;
  let noMatch = 0;

  for (let i = 0; i < shorts.length; i++) {
    const s = shorts[i];
    const words = await fetchSubs(s.id);
    progress('short subs+align', i, shorts.length);
    if (!words) continue;
    withSubs++;

    const al = alignShort(s.id, words, idx);
    if (!al) {
      noMatch++;
      continue;
    }
    alignments.push(al);

    const p = perf.get(s.id);
    if (p === undefined) continue; // not eligible for a performance score (too young / 0 views)
    const ep = idx.eps.find((e) => e.id === al.episodeId);
    if (!ep) continue;
    features.push(shortFeatures(s, al, ep, p, words));
  }

  writeJson(path.join(dir, 'alignments.json'), alignments);
  writeJson(path.join(dir, 'features.json'), features);

  const result: MineResult = {
    nShorts: shorts.length,
    withSubs,
    aligned: alignments.length,
    episodesIndexed: episodesForIndex.length,
  };

  writeJson(path.join(dir, 'mine-report.json'), {
    ...result,
    noSubs: shorts.length - withSubs,
    noMatch,
    withFeatures: features.length,
    episodesConsidered: candidateEpisodes.length,
    episodesNoSubs,
    at: new Date().toISOString(),
  });

  return result;
}

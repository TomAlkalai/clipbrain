import fs from 'node:fs';
import path from 'node:path';
import { DATA } from '../config.js';
import { paths, readJsonOr, writeJson } from '../store.js';
import { buildSentences } from '../text/sentences.js';
import { foldOf, type HeldOutShort } from './folds.js';
import { gradeOf, type OfficialMoment } from './metrics.js';
import type { Alignment, RefShort, Sentence, ShortFeatures, Word } from '../types.js';

// Ranking-benchmark dataset (design §3): the episodes with aligned official Shorts, their official
// moments, folds and transcript statistics — built offline from mining outputs and caches only
// (no network, no LLM).

export type Segmentation = 'punctuation' | 'gaps';
export type TranscriptStats = {
  words: number;
  sentences: number;
  punctuationDensity: number;
  medianSentenceWords: number;
  segmentation: Segmentation;
};
export type BenchEpisode = {
  episodeId: string;
  title: string;
  durationSec: number;
  uploadDate: string;
  fold: number;
  /** Uploaded less than minAgeDays before mining — its set of official Shorts may be incomplete. null = unknown. */
  young: boolean | null;
  moments: OfficialMoment[];
  /** This episode's own Shorts: must never appear in its prompts (design §6). */
  heldOut: HeldOutShort[];
  transcript: TranscriptStats | null;
};
export type BenchDataset = {
  slug: string;
  createdAt: string;
  folds: number;
  minAgeDays: number;
  episodes: BenchEpisode[];
  summary: { episodes: number; moments: number; young: number; missingTranscripts: number; perFold: number[]; medianPunctuationDensity: number | null };
};

/** Below this share of words ending in . ? ! the captions are treated as unpunctuated (design §3). */
export const MIN_PUNCTUATION_DENSITY = 0.02;
const END_PUNCT_RE = /[.?!]["')]?$/;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Sentences for a benchmark transcript: production's buildSentences for punctuated captions;
 * shorter gap/length splits for unpunctuated auto-captions, which would otherwise come out as
 * 45-word runs split only on 1.2 s pauses.
 */
export function benchSentences(words: Word[], segmentation: Segmentation): Sentence[] {
  return segmentation === 'gaps' ? buildSentences(words, { maxGap: 0.6, maxWords: 30 }) : buildSentences(words);
}

export function transcriptStats(words: Word[]): TranscriptStats {
  const punct = words.filter((w) => END_PUNCT_RE.test(w.w.trim())).length;
  const punctuationDensity = words.length === 0 ? 0 : punct / words.length;
  const segmentation: Segmentation = punctuationDensity < MIN_PUNCTUATION_DENSITY ? 'gaps' : 'punctuation';
  const sentences = benchSentences(words, segmentation);
  return {
    words: words.length,
    sentences: sentences.length,
    punctuationDensity,
    medianSentenceWords: median(sentences.map((s) => s.w1 - s.w0 + 1)),
    segmentation,
  };
}

function parseYmd(d: string): Date | null {
  if (!/^\d{8}$/.test(d)) return null;
  const t = Date.UTC(Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8)));
  return Number.isNaN(t) ? null : new Date(t);
}

export type DatasetInput = {
  slug: string;
  alignments: Alignment[];
  features: ShortFeatures[];
  shorts: RefShort[];
  episodeMeta: Map<string, { title: string; durationSec: number; uploadDate: string }>;
  wordsByEpisode: Map<string, Word[] | null>;
  minedAt: Date | null;
  folds: number;
  minAgeDays: number;
  createdAt: string;
};

/** Pure: builds the dataset from already-loaded mining outputs and transcripts. */
export function assembleDataset(i: DatasetInput): BenchDataset {
  const featureById = new Map(i.features.map((f) => [f.shortId, f]));
  const shortById = new Map(i.shorts.map((s) => [s.id, s]));
  const byEpisode = new Map<string, Alignment[]>();
  for (const a of i.alignments) {
    if (a.segments.length === 0) continue;
    byEpisode.set(a.episodeId, [...(byEpisode.get(a.episodeId) ?? []), a]);
  }

  const episodes: BenchEpisode[] = [];
  for (const [episodeId, als] of byEpisode) {
    const meta = i.episodeMeta.get(episodeId);
    const words = i.wordsByEpisode.get(episodeId) ?? null;
    const uploaded = parseYmd(meta?.uploadDate ?? '');
    const moments: OfficialMoment[] = als.map((a) => {
      const f = featureById.get(a.shortId);
      const perf = f ? f.perf : null;
      return {
        shortId: a.shortId,
        title: f?.title ?? shortById.get(a.shortId)?.title ?? '',
        perf,
        grade: gradeOf(perf),
        segments: a.segments.map((s) => ({ start: s.srcStart, end: s.srcEnd })),
      };
    });
    episodes.push({
      episodeId,
      title: meta?.title ?? '(unknown title)',
      durationSec: meta?.durationSec || (words && words.length > 0 ? words[words.length - 1].end : 0),
      uploadDate: meta?.uploadDate ?? '',
      fold: foldOf(episodeId, i.folds),
      young: uploaded && i.minedAt ? (i.minedAt.getTime() - uploaded.getTime()) / 86_400_000 < i.minAgeDays : null,
      moments,
      heldOut: moments.map((m) => ({ shortId: m.shortId, title: m.title, text: featureById.get(m.shortId)?.text ?? '' })),
      transcript: words && words.length > 0 ? transcriptStats(words) : null,
    });
  }

  const densities = episodes.flatMap((e) => (e.transcript ? [e.transcript.punctuationDensity] : []));
  return {
    slug: i.slug,
    createdAt: i.createdAt,
    folds: i.folds,
    minAgeDays: i.minAgeDays,
    episodes,
    summary: {
      episodes: episodes.length,
      moments: episodes.reduce((s, e) => s + e.moments.length, 0),
      young: episodes.filter((e) => e.young === true).length,
      missingTranscripts: episodes.filter((e) => !e.transcript).length,
      perFold: Array.from({ length: i.folds }, (_, f) => episodes.filter((e) => e.fold === f).length),
      medianPunctuationDensity: densities.length ? median(densities) : null,
    },
  };
}

/** Episode titles/durations/upload dates from yt-dlp's cached channel listings (no network). */
function cachedEpisodeMeta(): Map<string, { title: string; durationSec: number; uploadDate: string }> {
  const meta = new Map<string, { title: string; durationSec: number; uploadDate: string }>();
  const dir = path.join(DATA, 'cache');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^list-.*\.json$/.test(f)) : [];
  for (const f of files) {
    for (const e of readJsonOr<RefShort[]>(path.join(dir, f), [])) {
      if (!meta.has(e.id) || !meta.get(e.id)!.uploadDate) meta.set(e.id, { title: e.title, durationSec: e.durationSec, uploadDate: e.uploadDate });
    }
  }
  return meta;
}

/** Cached json3 words for an episode (written by fetchSubs during `mine`), or null. */
export function cachedWords(videoId: string): Word[] | null {
  const cached = readJsonOr<unknown>(path.join(DATA, 'cache', 'subs', `${videoId}.json`), null);
  return Array.isArray(cached) ? (cached as Word[]) : null;
}

export function datasetPath(slug: string): string {
  return path.join(DATA, 'bench', slug, 'dataset.json');
}

/** Builds and writes data/bench/<slug>/dataset.json from `mine` outputs and local caches only. */
export function buildDataset(slug: string, o: { folds?: number; minAgeDays?: number } = {}): BenchDataset {
  const dir = paths.creator(slug);
  const alignments = readJsonOr<Alignment[]>(path.join(dir, 'alignments.json'), []);
  if (alignments.length === 0) throw new Error(`no alignments for "${slug}" — run \`cb mine ${slug}\` first`);
  const report = readJsonOr<{ at?: string } | null>(path.join(dir, 'mine-report.json'), null);
  const episodeIds = [...new Set(alignments.map((a) => a.episodeId))];
  const ds = assembleDataset({
    slug,
    alignments,
    features: readJsonOr<ShortFeatures[]>(path.join(dir, 'features.json'), []),
    shorts: readJsonOr<RefShort[]>(path.join(dir, 'shorts.json'), []),
    episodeMeta: cachedEpisodeMeta(),
    wordsByEpisode: new Map(episodeIds.map((id) => [id, cachedWords(id)])),
    minedAt: report?.at ? new Date(report.at) : null,
    folds: o.folds ?? 3,
    minAgeDays: o.minAgeDays ?? 21,
    createdAt: new Date().toISOString(),
  });
  writeJson(datasetPath(slug), ds);
  return ds;
}

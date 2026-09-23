import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA } from '../config.js';
import { ffmpeg, ytdlp } from '../tools/bins.js';
import { runOk } from '../tools/proc.js';
import { parseJson3 } from '../text/json3.js';
import { readJsonOr, writeJson, newId } from '../store.js';
import { log } from '../log.js';
import type { Word, RefShort } from '../types.js';

// Network calls hit YouTube and can be slow/flaky, so timeouts are generous rather than tight.
const LISTING_TIMEOUT_MS = 5 * 60 * 1000; // channel/tab flat-playlist listing
const VIDEO_INFO_TIMEOUT_MS = 2 * 60 * 1000; // single video metadata (-J)
const SUBS_TIMEOUT_MS = 3 * 60 * 1000; // subtitle track download
const AUDIO_TIMEOUT_MS = 10 * 60 * 1000; // bestaudio download + resample
const PROXY_TIMEOUT_MS = 15 * 60 * 1000; // full low-res proxy download
const SECTION_TIMEOUT_MS = 15 * 60 * 1000; // hi-res section download

const LIST_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tmpDir(): string {
  const p = path.join(DATA, 'tmp', newId('tmp'));
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function rmDir(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

// ['--js-runtimes', 'node', '--no-warnings', '--ffmpeg-location', <dir>] — the ffmpeg-location
// pair is omitted when ffmpeg() resolves to a bare command name (no directory component),
// since yt-dlp would otherwise be pointed at the current working directory.
export function baseArgs(): string[] {
  const args = ['--js-runtimes', 'node', '--no-warnings'];
  const ff = ffmpeg();
  const dir = path.dirname(ff);
  if (dir !== '.') {
    args.push('--ffmpeg-location', dir);
  }
  return args;
}

// Pure mapper from yt-dlp's --flat-playlist -J JSON to our RefShort shape.
export function mapFlatEntries(json: any, channelUrl: string): RefShort[] {
  const entries: any[] = json?.entries ?? [];
  return entries.map((e) => ({
    id: e.id,
    title: e.title,
    views: e.view_count ?? 0,
    durationSec: e.duration ?? 0,
    uploadDate: e.upload_date ?? '',
    channelUrl,
  }));
}

function listCachePath(url: string, tab: string, limit: number): string {
  const key = crypto.createHash('sha1').update(`${url}|${tab}|${limit}`).digest('hex');
  return path.join(DATA, 'cache', `list-${key}.json`);
}

function isFresh(p: string, maxAgeMs: number): boolean {
  try {
    return Date.now() - fs.statSync(p).mtimeMs < maxAgeMs;
  } catch {
    return false;
  }
}

export async function listChannel(url: string, tab: 'shorts' | 'videos', limit: number): Promise<RefShort[]> {
  const cachePath = listCachePath(url, tab, limit);
  if (isFresh(cachePath, LIST_CACHE_TTL_MS)) {
    const cached = readJsonOr<RefShort[] | null>(cachePath, null);
    if (cached) return cached;
  }

  const args = [...baseArgs(), '--flat-playlist', '-J', '--playlist-end', String(limit), `${url}/${tab}`];
  const r = await runOk(ytdlp(), args, { timeoutMs: LISTING_TIMEOUT_MS });
  const json = JSON.parse(r.stdout);
  const list = mapFlatEntries(json, url);

  if (tab === 'shorts') {
    const targets = list.slice(0, limit).filter((e) => e.uploadDate === '');
    for (let i = 0; i < targets.length; i++) {
      if (i > 0) await sleep(1000);
      try {
        const info = await videoInfo(targets[i].id);
        targets[i].uploadDate = info.uploadDate;
      } catch (err) {
        log(`videoInfo enrichment failed for ${targets[i].id}:`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  writeJson(cachePath, list);
  return list;
}

export type VideoInfo = {
  id: string;
  title: string;
  durationSec: number;
  width: number;
  height: number;
  channel: string;
  channelUrl: string;
  uploadDate: string;
  views: number;
};

export async function videoInfo(urlOrId: string): Promise<VideoInfo> {
  const url = /^https?:\/\//i.test(urlOrId) ? urlOrId : `https://www.youtube.com/watch?v=${urlOrId}`;
  const args = [...baseArgs(), '-J', '--no-playlist', '--skip-download', url];
  const r = await runOk(ytdlp(), args, { timeoutMs: VIDEO_INFO_TIMEOUT_MS });
  const j = JSON.parse(r.stdout);
  return {
    id: j.id,
    title: j.title,
    durationSec: j.duration ?? 0,
    width: j.width ?? 0,
    height: j.height ?? 0,
    channel: j.channel ?? j.uploader ?? '',
    channelUrl: j.channel_url ?? j.uploader_url ?? '',
    uploadDate: j.upload_date ?? '',
    views: j.view_count ?? 0,
  };
}

function subsCachePath(videoId: string): string {
  return path.join(DATA, 'cache', 'subs', `${videoId}.json`);
}

export async function fetchSubs(videoId: string): Promise<Word[] | null> {
  const cp = subsCachePath(videoId);
  const cached = readJsonOr<unknown>(cp, undefined);
  if (cached !== undefined) {
    if (cached && typeof cached === 'object' && !Array.isArray(cached) && (cached as any).none === true) {
      return null;
    }
    return cached as Word[];
  }

  const dir = tmpDir();
  try {
    const args = [
      ...baseArgs(),
      '--skip-download',
      '--write-auto-subs',
      '--write-subs',
      '--sub-langs',
      'en,en-orig,en-US,en-GB',
      '--sub-format',
      'json3',
      '-o',
      path.join(dir, '%(id)s.%(ext)s'),
      `https://www.youtube.com/watch?v=${videoId}`,
    ];
    await runOk(ytdlp(), args, { timeoutMs: SUBS_TIMEOUT_MS });

    const files = fs.readdirSync(dir);
    let chosen = files.find((f) => f === `${videoId}.en.json3`);
    if (!chosen) {
      chosen = files.find((f) => f.startsWith(`${videoId}.en`) && f.endsWith('.json3'));
    }

    if (!chosen) {
      writeJson(cp, { none: true });
      return null;
    }

    const json = JSON.parse(fs.readFileSync(path.join(dir, chosen), 'utf8'));
    const words = parseJson3(json);
    writeJson(cp, words);
    return words;
  } finally {
    rmDir(dir);
  }
}

export async function downloadAudio(url: string, outWav: string): Promise<void> {
  const dir = tmpDir();
  try {
    const args = [...baseArgs(), '-f', 'bestaudio', '-o', path.join(dir, 'a.%(ext)s'), url];
    await runOk(ytdlp(), args, { timeoutMs: AUDIO_TIMEOUT_MS });

    const files = fs.readdirSync(dir).filter((f) => f.startsWith('a.'));
    if (files.length === 0) throw new Error(`yt-dlp produced no audio file for ${url}`);
    const audioPath = path.join(dir, files[0]);

    fs.mkdirSync(path.dirname(outWav), { recursive: true });
    await runOk(ffmpeg(), ['-y', '-i', audioPath, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outWav], {
      timeoutMs: AUDIO_TIMEOUT_MS,
    });
  } finally {
    rmDir(dir);
  }
}

export async function downloadProxy(url: string, outMp4: string): Promise<void> {
  fs.mkdirSync(path.dirname(outMp4), { recursive: true });
  const args = [
    ...baseArgs(),
    '-f',
    'bv*[height<=360][ext=mp4]/bv*[height<=360]/wv*',
    '--remux-video',
    'mp4',
    '-o',
    outMp4,
    url,
  ];
  await runOk(ytdlp(), args, { timeoutMs: PROXY_TIMEOUT_MS });
}

export async function downloadSection(url: string, start: number, end: number, outMp4: string): Promise<void> {
  fs.mkdirSync(path.dirname(outMp4), { recursive: true });
  const args = [
    ...baseArgs(),
    '-f',
    'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b',
    '--download-sections',
    `*${start}-${end}`,
    '--force-keyframes-at-cuts',
    '--merge-output-format',
    'mp4',
    '-o',
    outMp4,
    url,
  ];
  await runOk(ytdlp(), args, { timeoutMs: SECTION_TIMEOUT_MS });
}

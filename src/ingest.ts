import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.js';
import { videoInfo, downloadAudio, downloadProxy, canonicalWatchUrl } from './yt/ytdlp.js';
import { ffmpeg, ffprobe } from './tools/bins.js';
import { runOk } from './tools/proc.js';
import { paths, listDirs, readJsonOr, loadCreator, saveSource, newId } from './store.js';
import { log, step } from './log.js';
import type { Source } from './types.js';

function findExistingSource(predicate: (s: Source) => boolean): Source | null {
  const dir = path.join(DATA, 'sources');
  for (const id of listDirs(dir)) {
    const s = readJsonOr<Source | null>(path.join(paths.source(id), 'source.json'), null);
    if (s && predicate(s)) return s;
  }
  return null;
}

/**
 * Pure: ffprobe JSON → the DISPLAYED frame size and duration. ffprobe reports a stream's coded
 * size, but ffmpeg auto-rotates on every transcode (proxy, hi-res), so a phone video stored
 * landscape with a 90°/270° display rotation must be recorded portrait — otherwise srcAspect
 * disagrees with the frames every later stage sees. An audio-only file has nothing to crop or
 * render, so it's rejected here with a clear error instead of failing later in ffmpeg.
 */
export function parseProbe(j: any, label = 'input'): { width: number; height: number; durationSec: number } {
  const streams: any[] = j?.streams ?? [];
  const v = streams.find((s) => Number(s?.width) > 0 && Number(s?.height) > 0);
  if (!v) throw new Error(`no video stream in ${label} — a clip source needs video`);
  const rotation = Number(v.side_data_list?.find((d: any) => d?.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0);
  const quarterTurn = Math.abs(Math.round(rotation)) % 180 === 90;
  const width = Number(v.width);
  const height = Number(v.height);
  return {
    width: quarterTurn ? height : width,
    height: quarterTurn ? width : height,
    durationSec: Number(j?.format?.duration ?? 0) || 0,
  };
}

async function probeLocalFile(filePath: string): Promise<{ width: number; height: number; durationSec: number }> {
  const r = await runOk(ffprobe(), [
    '-v',
    'error',
    '-show_entries',
    'stream=width,height:stream_side_data=rotation:stream_tags=rotate:format=duration',
    '-of',
    'json',
    filePath,
  ]);
  return parseProbe(JSON.parse(r.stdout), path.basename(filePath));
}

export async function ingest(input: string, creator: string): Promise<Source> {
  const creatorFilePath = path.join(paths.creator(creator), 'creator.json');
  if (!fs.existsSync(creatorFilePath)) {
    throw new Error(`unknown creator '${creator}' — record it first with \`cb creator add\``);
  }
  const c = loadCreator(creator);
  if (!c.clippingPermission) {
    throw new Error("record the creator's clipping permission with `cb creator add`");
  }

  const isUrl = /^https?:\/\//i.test(input);

  if (isUrl) {
    const info = await videoInfo(input);
    const existing = findExistingSource((s) => s.kind === 'youtube' && s.videoId === info.id);
    if (existing) {
      log(`source already exists for videoId=${info.id}: ${existing.id}`);
      return existing;
    }

    // Stored and downloaded as the canonical watch URL, never the pasted one: a playlist-page URL
    // would otherwise drive every later download, and `url` is published in clip descriptions.
    const url = canonicalWatchUrl(info.id);
    const id = newId('src');
    const dir = paths.source(id);
    fs.mkdirSync(dir, { recursive: true });
    try {
      const audioPath = path.join(dir, 'audio.wav');
      const proxyPath = path.join(dir, 'proxy.mp4');

      const doneAudio = step(`downloading audio (${info.id})`);
      await downloadAudio(url, audioPath);
      doneAudio();

      const doneProxy = step(`downloading proxy (${info.id})`);
      await downloadProxy(url, proxyPath);
      doneProxy();

      const source: Source = {
        id,
        creator,
        kind: 'youtube',
        url,
        videoId: info.id,
        title: info.title,
        durationSec: info.durationSec,
        width: info.width,
        height: info.height,
        createdAt: new Date().toISOString(),
      };
      saveSource(source);
      log(`ingested ${id}: ${source.title} (${source.durationSec}s)`);
      return source;
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  }

  // Local file.
  const filePath = path.resolve(input);
  if (!fs.existsSync(filePath)) {
    throw new Error(`local file not found: ${filePath}`);
  }
  const existing = findExistingSource((s) => s.kind === 'file' && s.filePath === filePath);
  if (existing) {
    log(`source already exists for filePath=${filePath}: ${existing.id}`);
    return existing;
  }

  const probe = await probeLocalFile(filePath);
  const id = newId('src');
  const dir = paths.source(id);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const audioPath = path.join(dir, 'audio.wav');
    const proxyPath = path.join(dir, 'proxy.mp4');

    const doneAudio = step(`extracting audio (${path.basename(filePath)})`);
    await runOk(ffmpeg(), ['-y', '-i', filePath, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audioPath]);
    doneAudio();

    const doneProxy = step(`building proxy (${path.basename(filePath)})`);
    await runOk(ffmpeg(), [
      '-y',
      '-i',
      filePath,
      '-an',
      '-vf',
      'scale=-2:360',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '28',
      proxyPath,
    ]);
    doneProxy();

    const source: Source = {
      id,
      creator,
      kind: 'file',
      filePath,
      title: path.basename(filePath, path.extname(filePath)),
      durationSec: probe.durationSec,
      width: probe.width,
      height: probe.height,
      createdAt: new Date().toISOString(),
    };
    saveSource(source);
    log(`ingested ${id}: ${source.title} (${source.durationSec}s)`);
    return source;
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

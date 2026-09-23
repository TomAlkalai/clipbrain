import fs from 'node:fs';
import path from 'node:path';
import { installWhisperCpp, downloadWhisperModel, type WhisperModel } from '@remotion/install-whisper-cpp';
import { BIN, DATA, env } from '../config.js';
import { run } from './proc.js';
import { log } from '../log.js';

const WINGET_FFMPEG = 'C:\\Users\\tomal\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe';
const WINGET_FFPROBE = 'C:\\Users\\tomal\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffprobe.exe';

export function ffmpeg(): string {
  const fromEnv = env('FFMPEG_PATH');
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  if (fs.existsSync(WINGET_FFMPEG)) return WINGET_FFMPEG;
  return 'ffmpeg';
}

export function ffprobe(): string {
  const fromEnv = env('FFPROBE_PATH');
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  if (fs.existsSync(WINGET_FFPROBE)) return WINGET_FFPROBE;
  return 'ffprobe';
}

export function ytdlp(): string {
  const p = path.join(BIN, 'yt-dlp.exe');
  if (!fs.existsSync(p)) throw new Error('missing yt-dlp — run `cb setup`');
  return p;
}

export function whisperDir(): string {
  return path.join(BIN, 'whisper.cpp');
}

export function whisperModel(): string {
  return env('CB_WHISPER_MODEL', 'base.en')!;
}

function whisperExe(): string {
  return path.join(whisperDir(), 'main.exe');
}

function whisperModelPath(): string {
  return path.join(whisperDir(), `ggml-${whisperModel()}.bin`);
}

export function ultrafaceModel(): string {
  return path.join(BIN, 'models', 'ultraface-rfb-320.onnx');
}

async function downloadToFile(url: string, dest: string): Promise<{ status: number; bytes: number }> {
  const res = await fetch(url);
  if (res.status !== 200 || !res.body) {
    return { status: res.status, bytes: 0 };
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return { status: res.status, bytes: buf.byteLength };
}

export async function setup(): Promise<void> {
  const ytdlpPath = path.join(BIN, 'yt-dlp.exe');
  if (!fs.existsSync(ytdlpPath)) {
    log('downloading yt-dlp.exe...');
    const { status, bytes } = await downloadToFile(
      'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
      ytdlpPath,
    );
    if (status !== 200) throw new Error(`failed to download yt-dlp.exe: HTTP ${status}`);
    log(`yt-dlp.exe downloaded: ${(bytes / (1024 * 1024)).toFixed(1)} MB`);
  } else {
    log('yt-dlp.exe already present');
  }

  fs.mkdirSync(whisperDir(), { recursive: true });
  await installWhisperCpp({ to: whisperDir(), version: '1.5.5' });
  await downloadWhisperModel({ model: whisperModel() as WhisperModel, folder: whisperDir() });

  const facePath = ultrafaceModel();
  if (!fs.existsSync(facePath)) {
    log('downloading UltraFace model...');
    let result = await downloadToFile(
      'https://github.com/onnx/models/raw/main/validated/vision/body_analysis/ultraface/models/version-RFB-320.onnx',
      facePath,
    );
    if (result.status !== 200) {
      result = await downloadToFile(
        'https://github.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB/raw/master/models/onnx/version-RFB-320.onnx',
        facePath,
      );
    }
    if (result.status !== 200) throw new Error(`failed to download UltraFace model: HTTP ${result.status}`);
    if (result.bytes <= 500 * 1024) {
      throw new Error(`UltraFace model too small (${result.bytes} bytes) — download likely failed`);
    }
    log(`UltraFace model downloaded: ${(result.bytes / (1024 * 1024)).toFixed(1)} MB`);
  } else {
    log('UltraFace model already present');
  }
}

export type DoctorRow = { name: string; ok: boolean; detail: string };

const REQUIRED_FFMPEG_FILTERS = ['scdet', 'ebur128', 'blackdetect', 'freezedetect', 'silencedetect', 'loudnorm'];

export async function doctor(): Promise<DoctorRow[]> {
  const rows: DoctorRow[] = [];

  rows.push({ name: 'node', ok: true, detail: process.version });

  try {
    const versionRes = await run(ffmpeg(), ['-version']);
    const firstLine = versionRes.stdout.split(/\r?\n/)[0] ?? '';
    const filtersRes = await run(ffmpeg(), ['-filters']);
    const missing = REQUIRED_FFMPEG_FILTERS.filter((f) => !filtersRes.stdout.includes(f));
    const ok = versionRes.code === 0 && filtersRes.code === 0 && missing.length === 0;
    const detail = ok ? firstLine : `${firstLine} — missing filters: ${missing.join(', ')}`;
    rows.push({ name: 'ffmpeg', ok, detail });
  } catch (err) {
    rows.push({ name: 'ffmpeg', ok: false, detail: String(err) });
  }

  try {
    const r = await run(ffprobe(), ['-version']);
    const firstLine = r.stdout.split(/\r?\n/)[0] ?? '';
    rows.push({ name: 'ffprobe', ok: r.code === 0, detail: firstLine });
  } catch (err) {
    rows.push({ name: 'ffprobe', ok: false, detail: String(err) });
  }

  try {
    const p = ytdlp();
    const r = await run(p, ['--version']);
    rows.push({ name: 'yt-dlp', ok: r.code === 0, detail: r.stdout.trim() });
  } catch (err) {
    rows.push({ name: 'yt-dlp', ok: false, detail: err instanceof Error ? err.message : String(err) });
  }

  {
    const exePath = whisperExe();
    const modelPath = whisperModelPath();
    const exeOk = fs.existsSync(exePath);
    const modelOk = fs.existsSync(modelPath);
    const ok = exeOk && modelOk;
    const missing: string[] = [];
    if (!exeOk) missing.push(exePath);
    if (!modelOk) missing.push(modelPath);
    rows.push({
      name: 'whisper.cpp',
      ok,
      detail: ok ? `${exePath}, ${modelPath}` : `missing: ${missing.join(', ')}`,
    });
  }

  {
    const p = ultrafaceModel();
    const ok = fs.existsSync(p);
    rows.push({ name: 'ultraface', ok, detail: ok ? p : `missing: ${p}` });
  }

  try {
    const r = await run('claude', ['--version'], { shell: true });
    rows.push({ name: 'claude', ok: r.code === 0, detail: r.stdout.trim() || r.stderr.trim() });
  } catch (err) {
    rows.push({ name: 'claude', ok: false, detail: err instanceof Error ? err.message : String(err) });
  }

  try {
    fs.mkdirSync(DATA, { recursive: true });
    const stats = fs.statfsSync(DATA);
    const freeGb = (Number(stats.bavail) * Number(stats.bsize)) / 1e9;
    rows.push({
      name: 'disk',
      ok: freeGb >= 5,
      detail: `${freeGb.toFixed(1)} GB free`,
    });
  } catch (err) {
    rows.push({ name: 'disk', ok: false, detail: err instanceof Error ? err.message : String(err) });
  }

  try {
    fs.mkdirSync(DATA, { recursive: true });
    const probe = path.join(DATA, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe);
    rows.push({ name: 'data-writable', ok: true, detail: DATA });
  } catch (err) {
    rows.push({ name: 'data-writable', ok: false, detail: err instanceof Error ? err.message : String(err) });
  }

  return rows;
}

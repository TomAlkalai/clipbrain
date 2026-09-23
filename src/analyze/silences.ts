import path from 'node:path';
import { ffmpeg } from '../tools/bins.js';
import { run } from '../tools/proc.js';
import { paths, writeJson } from '../store.js';
import { log, step } from '../log.js';
import type { Silence } from '../types.js';

const START_RE = /silence_start:\s*(-?[\d.]+)/;
const END_RE = /silence_end:\s*(-?[\d.]+)/;

// Pure: parse ffmpeg's `silencedetect` stderr into [{start,end}] pairs. A dangling
// silence_start with no matching silence_end (silence runs to EOF) is dropped, since we
// have no reliable end time for it.
export function parseSilencedetect(stderr: string): Silence[] {
  const silences: Silence[] = [];
  let pendingStart: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const startMatch = START_RE.exec(line);
    if (startMatch) {
      pendingStart = parseFloat(startMatch[1]);
      continue;
    }
    const endMatch = END_RE.exec(line);
    if (endMatch && pendingStart !== null) {
      silences.push({ start: pendingStart, end: parseFloat(endMatch[1]) });
      pendingStart = null;
    }
  }
  return silences;
}

export async function detectSilences(id: string): Promise<Silence[]> {
  const dir = paths.source(id);
  const audioPath = path.join(dir, 'audio.wav');
  const outPath = path.join(dir, 'silences.json');

  const done = step(`detecting silences (${id})`);
  const r = await run(ffmpeg(), [
    '-hide_banner',
    '-i',
    audioPath,
    '-af',
    'silencedetect=noise=-35dB:d=0.35',
    '-f',
    'null',
    '-',
  ]);
  if (r.code !== 0) {
    throw new Error(`ffmpeg silencedetect exited with code ${r.code}: ${r.stderr.slice(-2000)}`);
  }
  const silences = parseSilencedetect(r.stderr);
  done(`${silences.length} silences`);

  writeJson(outPath, silences);
  log(`detected ${silences.length} silences for ${id}`);
  return silences;
}

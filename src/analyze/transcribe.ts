import os from 'node:os';
import path from 'node:path';
import { transcribe, toCaptions, type WhisperModel } from '@remotion/install-whisper-cpp';
import { whisperDir, whisper192Dir, whisperModel } from '../tools/bins.js';
import { paths, readJsonOr, writeJson } from '../store.js';
import { buildSentences } from '../text/sentences.js';
import { log, step } from '../log.js';
import type { Word } from '../types.js';

const BRACKETED_RE = /^\[[^\]]*\]$/; // e.g. [Music], [BLANK_AUDIO] — non-speech markers

// Pure: whisper.cpp's token-level output (via toCaptions) yields one item per token. A token
// whose text does NOT start with a space is a sub-word continuation of the previous token
// (e.g. "Hor" + "mozi" -> "Hormozi") and gets merged in, extending the previous word's end
// time. Bracketed non-speech markers and empty/whitespace-only tokens are dropped.
export function wordsFromCaptions(caps: { text: string; startMs: number; endMs: number }[]): Word[] {
  const words: Word[] = [];
  for (const cap of caps) {
    const isContinuation = cap.text.length > 0 && !cap.text.startsWith(' ') && words.length > 0;
    if (isContinuation) {
      const last = words[words.length - 1];
      last.w += cap.text;
      last.end = cap.endMs / 1000;
      // whisper.cpp sometimes splits a bracketed marker across tokens (e.g. " [MUSIC" + "]"),
      // so the marker only becomes a complete "[...]" after this merge — re-check here too.
      if (BRACKETED_RE.test(last.w.trim())) words.pop();
      continue;
    }
    const trimmed = cap.text.trim();
    if (trimmed === '' || BRACKETED_RE.test(trimmed)) continue;
    words.push({ w: trimmed, start: cap.startMs / 1000, end: cap.endMs / 1000 });
  }
  return words;
}

// Fraction of DTW token timestamps that came back null/negative above which we consider the
// run broken (almost always means -nfa/flash-attention got flipped and DTW alignment failed).
const MAX_BAD_TIMESTAMP_RATIO = 0.01;

export async function transcribeSource(id: string): Promise<Word[]> {
  const dir = paths.source(id);
  const wordsPath = path.join(dir, 'words.json');

  const existing = readJsonOr<Word[] | null>(wordsPath, null);
  if (existing) {
    log(`transcribeSource(${id}): words.json already exists, skipping`);
    return existing;
  }

  const audioPath = path.join(dir, 'audio.wav');
  const threads = Math.max(2, os.cpus().length - 1);

  const done = step(`transcribing ${id} (whisper.cpp 1.9.2, ${threads} threads)`);
  const out = await transcribe({
    inputPath: audioPath,
    whisperPath: whisper192Dir(),
    whisperCppVersion: '1.9.2',
    model: whisperModel() as WhisperModel,
    modelFolder: whisperDir(),
    tokenLevelTimestamps: true,
    printOutput: false,
    // -nfa is REQUIRED: flash attention breaks DTW token timestamps (they come back -1).
    additionalArgs: ['-nfa', '-bs', '1', '-bo', '1', '-t', String(threads)],
  });
  done();

  const { captions } = toCaptions({ whisperCppOutput: out });

  const bad = captions.filter((c) => c.timestampMs == null || c.timestampMs < 0).length;
  const badRatio = captions.length === 0 ? 0 : bad / captions.length;
  if (badRatio > MAX_BAD_TIMESTAMP_RATIO) {
    throw new Error(
      `transcription DTW timestamps look broken for ${id}: ${bad}/${captions.length} tokens ` +
        `(${(badRatio * 100).toFixed(1)}%) have null/negative timestamps (>1% threshold). ` +
        'Check that -nfa is being passed (flash attention breaks DTW token timestamps).',
    );
  }

  const words = wordsFromCaptions(captions);
  writeJson(wordsPath, words);

  const sentences = buildSentences(words);
  writeJson(path.join(dir, 'sentences.json'), sentences);

  log(`transcribed ${id}: ${words.length} words, ${sentences.length} sentences`);
  return words;
}

import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../store.js';
import { log } from '../log.js';
import { transcribeSource } from './transcribe.js';
import { detectSilences } from './silences.js';
import { scanVisual } from './visual.js';

export type AnalyzeOpts = { force?: boolean };

/**
 * Runs the full per-source analysis pipeline in order: transcription, silence detection, then
 * the visual scan (shots + faces). Each step skips when its outputs already exist (words.json;
 * silences.json; shots.json + faces.json respectively), unless `force`.
 *
 * transcribeSource and detectSilences don't take a `force` option themselves — transcribeSource
 * already skips on its own when words.json exists, so forcing it means removing that file first;
 * detectSilences has no skip logic at all (it always re-runs and overwrites), so forcing it just
 * means calling it. scanVisual already accepts `{ force }` directly.
 */
export async function analyzeSource(id: string, o?: AnalyzeOpts): Promise<void> {
  const force = Boolean(o?.force);
  const dir = paths.source(id);
  const wordsPath = path.join(dir, 'words.json');
  const silencesPath = path.join(dir, 'silences.json');

  if (force && fs.existsSync(wordsPath)) fs.rmSync(wordsPath);
  if (force || !fs.existsSync(wordsPath)) {
    await transcribeSource(id);
  } else {
    log(`analyzeSource(${id}): words.json already exists, skipping transcribe`);
  }

  if (force || !fs.existsSync(silencesPath)) {
    await detectSilences(id);
  } else {
    log(`analyzeSource(${id}): silences.json already exists, skipping silence detection`);
  }

  await scanVisual(id, { force });
}

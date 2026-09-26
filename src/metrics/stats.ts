import fs from 'node:fs';
import { listClips, loadClip, saveClip } from '../store.js';
import { videoInfo } from '../yt/ytdlp.js';
import { getClient } from '../publish/oauth.js';
import { log } from '../log.js';
import type { Clip } from '../types.js';
import type { OAuth2Client } from 'google-auth-library';

const ANALYTICS_URL = 'https://youtubeanalytics.googleapis.com/v2/reports';
const MAX_IDS_PER_CALL = 200;

type AnalyticsRow = { views: number; engagedViews?: number; avgViewPct?: number; avgViewSec?: number };

function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

async function runAnalyticsReport(
  client: OAuth2Client,
  ids: string[],
  metrics: string,
): Promise<{ columnHeaders: { name: string }[]; rows?: unknown[][] }> {
  const today = new Date().toISOString().slice(0, 10);
  const params = new URLSearchParams({
    ids: 'channel==MINE',
    startDate: '2020-01-01',
    endDate: today,
    metrics,
    dimensions: 'video',
    filters: `video==${ids.join(',')}`,
  });
  const res = await client.request<{ columnHeaders: { name: string }[]; rows?: unknown[][] }>({
    url: `${ANALYTICS_URL}?${params.toString()}`,
  });
  return res.data;
}

async function fetchAnalyticsBatch(client: OAuth2Client, ids: string[]): Promise<Map<string, AnalyticsRow>> {
  const withEngaged = 'views,engagedViews,averageViewPercentage,averageViewDuration';
  const withoutEngaged = 'views,averageViewPercentage,averageViewDuration';

  let data: { columnHeaders: { name: string }[]; rows?: unknown[][] };
  try {
    data = await runAnalyticsReport(client, ids, withEngaged);
  } catch (err) {
    log('YouTube Analytics: engagedViews rejected, retrying without it:', err instanceof Error ? err.message : String(err));
    data = await runAnalyticsReport(client, ids, withoutEngaged);
  }

  const headers = (data.columnHeaders ?? []).map((h) => h.name);
  const map = new Map<string, AnalyticsRow>();
  for (const row of data.rows ?? []) {
    const rec: Record<string, unknown> = {};
    headers.forEach((h, i) => {
      rec[h] = row[i];
    });
    const videoId = String(rec.video);
    map.set(videoId, {
      views: Number(rec.views ?? 0),
      engagedViews: rec.engagedViews !== undefined ? Number(rec.engagedViews) : undefined,
      avgViewPct: rec.averageViewPercentage !== undefined ? Number(rec.averageViewPercentage) : undefined,
      avgViewSec: rec.averageViewDuration !== undefined ? Number(rec.averageViewDuration) : undefined,
    });
  }
  return map;
}

async function publicStats(videoId: string): Promise<{ views: number }> {
  const info = await videoInfo(videoId);
  return { views: info.views };
}

function publishedClips(): Clip[] {
  return listClips((c) => c.status === 'published' && !!c.publish?.videoId);
}

// Appends one metrics snapshot per published clip: YouTube Analytics when authorized, otherwise
// the public view count via yt-dlp. Returns the number of clips updated.
export async function collectStats(): Promise<number> {
  const clips = publishedClips();
  if (clips.length === 0) return 0;

  const client = await getClient();
  const at = new Date().toISOString();
  let updated = 0;

  if (client) {
    for (const batch of chunk(clips, MAX_IDS_PER_CALL)) {
      const ids = batch.map((c) => c.publish!.videoId);
      const analytics = await fetchAnalyticsBatch(client, ids);
      for (const clip of batch) {
        const row = analytics.get(clip.publish!.videoId);
        if (!row) {
          log(`stats: no analytics row for clip ${clip.id} (${clip.publish!.videoId})`);
          continue;
        }
        clip.metrics = clip.metrics ?? [];
        clip.metrics.push({
          at,
          views: row.views,
          engagedViews: row.engagedViews,
          avgViewPct: row.avgViewPct,
          avgViewSec: row.avgViewSec,
          source: 'analytics',
        });
        saveClip(clip);
        updated++;
      }
    }
    return updated;
  }

  for (const clip of clips) {
    try {
      const stat = await publicStats(clip.publish!.videoId);
      clip.metrics = clip.metrics ?? [];
      clip.metrics.push({ at, views: stat.views, source: 'public' });
      saveClip(clip);
      updated++;
    } catch (err) {
      log(`stats: publicStats failed for clip ${clip.id}:`, err instanceof Error ? err.message : String(err));
    }
  }
  return updated;
}

export type CsvRowError = { line: number; raw: string; message: string };
type ParsedRow = { line: number; raw: string; clipId: string; views: number; avgViewPct?: number };

// Pure: validates each data row (clipId,views,avgViewPct) — views must be a finite number >= 0;
// avgViewPct is optional but when present must be finite and within 0-100. Invalid rows are
// reported as errors rather than turned into NaN metrics, and are excluded from `rows`.
export function parseStatsCsv(text: string): { rows: ParsedRow[]; errors: CsvRowError[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const dataLines = lines.slice(1); // skip header: clipId,views,avgViewPct
  const rows: ParsedRow[] = [];
  const errors: CsvRowError[] = [];

  dataLines.forEach((raw, i) => {
    const line = i + 2; // 1-based, +1 to account for the header row
    const [clipId, viewsRaw, avgViewPctRaw] = raw.split(',').map((s) => s.trim());

    if (!clipId) {
      errors.push({ line, raw, message: 'missing clipId' });
      return;
    }

    const views = Number(viewsRaw);
    if (viewsRaw === undefined || viewsRaw === '' || !Number.isFinite(views) || views < 0) {
      errors.push({ line, raw, message: `views must be a finite number >= 0 (got "${viewsRaw ?? ''}")` });
      return;
    }

    let avgViewPct: number | undefined;
    if (avgViewPctRaw !== undefined && avgViewPctRaw !== '') {
      avgViewPct = Number(avgViewPctRaw);
      if (!Number.isFinite(avgViewPct) || avgViewPct < 0 || avgViewPct > 100) {
        errors.push({ line, raw, message: `avgViewPct must be a finite number 0-100 (got "${avgViewPctRaw}")` });
        return;
      }
    }

    rows.push({ line, raw, clipId, views, avgViewPct });
  });

  return { rows, errors };
}

export type CsvImportResult = { updated: number; errors: CsvRowError[] };

// Manually posted TikTok/IG copies: clipId,views,avgViewPct rows become metrics snapshots
// tagged source:'csv'. Loads clips individually so one bad row doesn't abort the rest; invalid
// rows (bad numbers, unknown clip id) are skipped and collected in `errors`, which the caller can
// inspect. Kept alongside `importCsv`, which stays on the CLI-facing `Promise<number>` contract.
export async function importCsvDetailed(csvPath: string): Promise<CsvImportResult> {
  const text = fs.readFileSync(csvPath, 'utf8');
  const { rows, errors } = parseStatsCsv(text);
  const at = new Date().toISOString();
  let updated = 0;

  for (const r of rows) {
    let clip: Clip;
    try {
      clip = loadClip(r.clipId);
    } catch {
      errors.push({ line: r.line, raw: r.raw, message: `no such clip "${r.clipId}"` });
      continue;
    }
    clip.metrics = clip.metrics ?? [];
    clip.metrics.push({ at, views: r.views, avgViewPct: r.avgViewPct, source: 'csv' });
    saveClip(clip);
    updated++;
  }

  for (const e of errors) {
    log(`stats import: line ${e.line}: ${e.message} (${e.raw})`);
  }

  return { updated, errors };
}

// CLI-facing wrapper: keeps the original Promise<number> contract (the count of clips updated)
// so callers that only want "how many rows landed" don't need to unpack a result object, while
// still reporting row errors and exiting non-zero when any row was invalid — the CSV can come
// from a hand-edited spreadsheet, so silently swallowing a bad row would corrupt a clip's metrics
// history without anyone noticing.
export async function importCsv(csvPath: string): Promise<number> {
  const { updated, errors } = await importCsvDetailed(csvPath);
  if (errors.length > 0) {
    process.exitCode = 1;
  }
  return updated;
}

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

export function parseStatsCsv(text: string): { clipId: string; views: number; avgViewPct: number }[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const rows = lines.slice(1); // skip header: clipId,views,avgViewPct
  return rows.map((line) => {
    const [clipId, views, avgViewPct] = line.split(',').map((s) => s.trim());
    return { clipId, views: Number(views), avgViewPct: Number(avgViewPct) };
  });
}

// Manually posted TikTok/IG copies: clipId,views,avgViewPct rows become metrics snapshots
// tagged source:'csv'. Loads clips individually so one bad row doesn't abort the rest.
export async function importCsv(csvPath: string): Promise<number> {
  const text = fs.readFileSync(csvPath, 'utf8');
  const rows = parseStatsCsv(text);
  const at = new Date().toISOString();
  let updated = 0;

  for (const r of rows) {
    let clip: Clip;
    try {
      clip = loadClip(r.clipId);
    } catch {
      log(`stats import: no such clip ${r.clipId}, skipping`);
      continue;
    }
    clip.metrics = clip.metrics ?? [];
    clip.metrics.push({ at, views: r.views, avgViewPct: r.avgViewPct, source: 'csv' });
    saveClip(clip);
    updated++;
  }
  return updated;
}

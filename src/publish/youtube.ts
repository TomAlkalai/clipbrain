import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config.js';
import { listClips, loadCreator, paths, saveClip } from '../store.js';
import { log } from '../log.js';
import { getClient } from './oauth.js';
import type { Clip } from '../types.js';
import type { OAuth2Client } from 'google-auth-library';
import { isPublished } from './state.js';

const MAX_TITLE_LEN = 100;
const MAX_DESCRIPTION_LEN = 4900;
const SHORTS_SUFFIX = ' #shorts';

// produce.ts's attribution() always appends "\n\nFrom \"<title>\" — <creator>\nFull episode: ...".
// Description truncation must find this marker and cut the body before it, never the marker itself.
const ATTRIBUTION_MARKER = '\n\nFrom "';

export type UploadRequest = {
  snippet: { title: string; description: string; tags: string[]; categoryId: '22' };
  status: { privacyStatus: 'private'; publishAt?: string; selfDeclaredMadeForKids: false };
};

// Pure: clamps a description to maxLen without ever cutting into the attribution block that
// attribution() appends at the end (creator name, full-episode link) — only the body ahead of it
// is trimmed, with a trailing "…" marking the cut. If the attribution block itself is longer than
// maxLen (pathological), it wins outright and gets truncated from its own start instead.
export function clampDescription(description: string, maxLen: number = MAX_DESCRIPTION_LEN): string {
  if (description.length <= maxLen) return description;

  const markerIdx = description.lastIndexOf(ATTRIBUTION_MARKER);
  if (markerIdx === -1) {
    return description.slice(0, Math.max(0, maxLen - 1)) + '…';
  }

  const attribution = description.slice(markerIdx);
  if (attribution.length >= maxLen) return attribution.slice(0, maxLen);

  const body = description.slice(0, markerIdx);
  const budget = maxLen - attribution.length;
  const truncatedBody = body.slice(0, Math.max(0, budget - 1)) + '…';
  return truncatedBody + attribution;
}

// Pure: builds the exact request body sent to the YouTube Data API. Title stays <= 100 chars;
// ` #shorts` is appended only when it still fits. Description keeps the attribution that's
// already baked into clip.description (never stripped) and is clamped at 4900 chars.
export function buildUploadRequest(clip: Clip, o: { publishAt?: string }): UploadRequest {
  let title = clip.title.trim();
  if (title.length > MAX_TITLE_LEN) title = title.slice(0, MAX_TITLE_LEN);
  if (title.length + SHORTS_SUFFIX.length <= MAX_TITLE_LEN) {
    title = title + SHORTS_SUFFIX;
  }

  const description = clampDescription(clip.description, MAX_DESCRIPTION_LEN);

  const tags = clip.hashtags.map((h) => h.replace(/^#/, ''));

  const status: UploadRequest['status'] = { privacyStatus: 'private', selfDeclaredMadeForKids: false };
  if (o.publishAt) status.publishAt = o.publishAt;

  return { snippet: { title, description, tags, categoryId: '22' }, status };
}

// Pure: which clips are safe to publish right now, and why the rest are skipped.
// Only approved clips that passed QC (or carry an override-approved qc_failed decision per R4:
// review.reason starting with "override:") and are not already published are eligible, and the
// remaining daily cap (dailyCap minus non-dry-run publishes in the last 24h) trims the list.
export function eligibleForPublish(
  clips: Clip[],
  now: Date,
  dailyCap: number,
): { eligible: Clip[]; skipped: { id: string; reason: string }[] } {
  const skipped: { id: string; reason: string }[] = [];
  const candidates: Clip[] = [];

  for (const c of clips) {
    if (isPublished(c)) {
      const reason = c.publish && !c.publish.dryRun ? `already published as video ${c.publish.videoId}` : 'already published';
      skipped.push({ id: c.id, reason });
      continue;
    }
    if (c.status !== 'approved') {
      skipped.push({ id: c.id, reason: `status is "${c.status}", not approved` });
      continue;
    }
    const override = c.review?.reason?.startsWith('override:') ?? false;
    const qcOk = c.qc?.ok === true;
    if (!qcOk && !override) {
      skipped.push({ id: c.id, reason: 'QC did not pass and no override was recorded' });
      continue;
    }
    candidates.push(c);
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const publishedRecently = clips.filter(
    (c) => c.publish && c.publish.dryRun === false && now.getTime() - new Date(c.publish.at).getTime() < dayMs,
  ).length;
  const remaining = Math.max(0, dailyCap - publishedRecently);

  const eligible = candidates.slice(0, remaining);
  for (const c of candidates.slice(remaining)) {
    skipped.push({ id: c.id, reason: `daily cap reached (${dailyCap}, ${publishedRecently} published in last 24h)` });
  }

  return { eligible, skipped };
}

function renderPath(clipId: string): string {
  return path.join(paths.clip(clipId), 'render.mp4');
}

async function checkChannel(client: OAuth2Client, expectedChannelId: string): Promise<void> {
  const res = await client.request<{ items?: { id: string }[] }>({
    url: 'https://www.googleapis.com/youtube/v3/channels?part=id&mine=true',
  });
  const channelId = res.data.items?.[0]?.id;
  if (!channelId || channelId !== expectedChannelId) {
    throw new Error(
      `authenticated YouTube channel (${channelId ?? 'none'}) does not match creator.publishChannelId (${expectedChannelId})`,
    );
  }
}

async function resumableUpload(client: OAuth2Client, req: UploadRequest, filePath: string): Promise<string> {
  const stat = fs.statSync(filePath);
  const initRes = await client.request<unknown>({
    url: 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    method: 'POST',
    headers: {
      'X-Upload-Content-Type': 'video/mp4',
      'X-Upload-Content-Length': String(stat.size),
    },
    data: req,
  });
  const location = (initRes.headers as Record<string, string>)['location'];
  if (!location) throw new Error('resumable upload session did not return a Location header');

  const { token } = await client.getAccessToken();
  const fileBuf = fs.readFileSync(filePath);
  const putRes = await fetch(location, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(stat.size),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: fileBuf,
  });
  if (!putRes.ok) {
    throw new Error(`resumable upload PUT failed: ${putRes.status} ${await putRes.text()}`);
  }
  const uploaded = (await putRes.json()) as { id: string };
  return uploaded.id;
}

// Pure: missing/blank config means the default cap of 10; "0" is a valid, deliberate value
// (publishing paused); anything non-numeric or negative is a config mistake, not a value to
// silently paper over, so it throws rather than falling back to a default.
export function parseDailyCap(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 10;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`invalid CB_PUBLISH_DAILY_CAP "${raw}": must be a non-negative number (0 pauses publishing)`);
  }
  return n;
}

export async function publish(o: { live: boolean; clipId?: string }): Promise<void> {
  const dailyCap = parseDailyCap(env('CB_PUBLISH_DAILY_CAP'));
  const now = new Date();

  const allClips = listClips();
  const { eligible, skipped } = eligibleForPublish(allClips, now, dailyCap);

  let toPublish = eligible;
  if (o.clipId) {
    toPublish = eligible.filter((c) => c.id === o.clipId);
    if (toPublish.length === 0) {
      const reason = skipped.find((s) => s.id === o.clipId)?.reason;
      log(`clip ${o.clipId} is not eligible to publish${reason ? `: ${reason}` : ''}`);
      return;
    }
  } else {
    for (const s of skipped) log(`skip ${s.id}: ${s.reason}`);
  }

  if (toPublish.length === 0) {
    log('no eligible clips to publish');
    return;
  }

  let client: OAuth2Client | null = null;
  if (o.live) {
    client = await getClient();
    if (!client) throw new Error('Not authorized — run `cb auth youtube`');
  }

  for (const clip of toPublish) {
    const publishAt =
      clip.plannedPublishAt && new Date(clip.plannedPublishAt).getTime() > now.getTime() ? clip.plannedPublishAt : undefined;
    const req = buildUploadRequest(clip, { publishAt });
    const mp4 = renderPath(clip.id);

    if (!o.live) {
      console.log(JSON.stringify(req, null, 2));
      log(`(dry-run) clip ${clip.id}: would upload ${mp4}`);
      continue;
    }

    if (!fs.existsSync(mp4)) {
      log(`clip ${clip.id}: no render found at ${mp4}, skipping`);
      continue;
    }

    const creator = loadCreator(clip.creator);
    if (!creator.publishChannelId) {
      throw new Error(`creator "${creator.slug}" has no publishChannelId configured`);
    }
    await checkChannel(client!, creator.publishChannelId);

    const videoId = await resumableUpload(client!, req, mp4);
    clip.publish = { videoId, publishAt, privacy: 'private', at: now.toISOString(), dryRun: false };
    clip.status = 'published';
    saveClip(clip);
    log(`published clip ${clip.id} as video ${videoId}`);
  }
}

import { it, expect } from 'vitest';
import { buildUploadRequest, eligibleForPublish, clampDescription, parseDailyCap } from '../src/publish/youtube.js';
import type { Clip } from '../src/types.js';

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip_1',
    sourceId: 'src_1',
    creator: 'doac',
    candidateId: 'cand_1',
    start: 0,
    end: 40,
    coldOpen: null,
    title: 'A short hook',
    description: 'Body text.\n\nFrom "Ep" — Creator\nFull episode: https://x',
    hashtags: ['#business', '#advice'],
    hooks: [{ text: 'A short hook', pattern: 'question', score: 8 }],
    hookIndex: 0,
    scores: {} as any,
    composite: 7,
    rankReason: '',
    patterns: [],
    hiresOffset: 0,
    status: 'approved',
    qc: { ok: true, checks: [], fixesApplied: [], at: new Date().toISOString() },
    renders: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Clip;
}

it('buildUploadRequest appends #shorts when the title has room', () => {
  const req = buildUploadRequest(clip({ title: 'Short hook' }), {});
  expect(req.snippet.title).toBe('Short hook #shorts');
  expect(req.status.privacyStatus).toBe('private');
  expect(req.status.selfDeclaredMadeForKids).toBe(false);
  expect(req.status.publishAt).toBeUndefined();
});

it('buildUploadRequest leaves the title alone when #shorts would not fit', () => {
  const title95 = 'A'.repeat(95);
  const req = buildUploadRequest(clip({ title: title95 }), {});
  expect(req.snippet.title).toBe(title95);
  expect(req.snippet.title.length).toBeLessThanOrEqual(100);
});

it('buildUploadRequest truncates an over-long title to 100 chars with no suffix', () => {
  const title150 = 'B'.repeat(150);
  const req = buildUploadRequest(clip({ title: title150 }), {});
  expect(req.snippet.title).toBe('B'.repeat(100));
  expect(req.snippet.title.length).toBe(100);
});

it('buildUploadRequest keeps the attribution in the description and clamps at 4900 chars', () => {
  const attributed = 'Body.\n\nFrom "Ep title" — Creator Name\nFull episode: https://youtu.be/x';
  const req = buildUploadRequest(clip({ description: attributed }), {});
  expect(req.snippet.description).toBe(attributed);

  const long = 'x'.repeat(5000) + attributed;
  const req2 = buildUploadRequest(clip({ description: long }), {});
  expect(req2.snippet.description.length).toBe(4900);
});

it('buildUploadRequest truncates the body but never the attribution, even with a 5000-char body', () => {
  const attribution = '\n\nFrom "How To Build A Business" — The Diary Of A CEO\nFull episode: https://youtu.be/fixture01';
  const long = 'x'.repeat(5000) + attribution;
  const req = buildUploadRequest(clip({ description: long }), {});
  expect(req.snippet.description.length).toBeLessThanOrEqual(4900);
  expect(req.snippet.description).toContain('Full episode');
  expect(req.snippet.description.endsWith(attribution)).toBe(true);
});

it('clampDescription is a no-op under the limit and preserves the attribution block when over it', () => {
  const attribution = '\n\nFrom "Ep" — Creator\nFull episode: https://x';
  const short = 'short body' + attribution;
  expect(clampDescription(short, 4900)).toBe(short);

  const long = 'y'.repeat(5000) + attribution;
  const clamped = clampDescription(long, 4900);
  expect(clamped.length).toBe(4900);
  expect(clamped.endsWith(attribution)).toBe(true);
  expect(clamped).toContain('…');
});

it('clampDescription falls back to a plain truncation when there is no attribution marker', () => {
  const noAttribution = 'z'.repeat(5000);
  const clamped = clampDescription(noAttribution, 4900);
  expect(clamped.length).toBe(4900);
  expect(clamped.endsWith('…')).toBe(true);
});

it('buildUploadRequest maps hashtags to tags and sets categoryId 22', () => {
  const req = buildUploadRequest(clip({ hashtags: ['#business', '#advice'] }), {});
  expect(req.snippet.tags).toEqual(['business', 'advice']);
  expect(req.snippet.categoryId).toBe('22');
});

it('buildUploadRequest sets status.publishAt when provided', () => {
  const req = buildUploadRequest(clip(), { publishAt: '2026-10-01T00:00:00.000Z' });
  expect(req.status.publishAt).toBe('2026-10-01T00:00:00.000Z');
});

it('eligibleForPublish excludes non-approved, qc-failed, and already-published clips', () => {
  const now = new Date('2026-09-26T12:00:00.000Z');
  const clips = [
    clip({ id: 'a', status: 'ready' }),
    clip({ id: 'b', status: 'approved', qc: { ok: false, checks: [], fixesApplied: [], at: '' } }),
    clip({ id: 'c', status: 'approved', qc: { ok: true, checks: [], fixesApplied: [], at: '' } }),
    clip({ id: 'd', status: 'published', publish: { videoId: 'v1', privacy: 'private', at: now.toISOString(), dryRun: false } }),
  ];
  const { eligible, skipped } = eligibleForPublish(clips, now, 10);
  expect(eligible.map((c) => c.id)).toEqual(['c']);
  expect(skipped.map((s) => s.id).sort()).toEqual(['a', 'b', 'd']);
});

it('eligibleForPublish treats an override-approved qc_failed clip as QC-acceptable (R4)', () => {
  const now = new Date('2026-09-26T12:00:00.000Z');
  const clips = [
    clip({
      id: 'e',
      status: 'approved',
      qc: { ok: false, checks: [], fixesApplied: [], at: '' },
      review: { decision: 'approved', reason: 'override: creator confirmed edgy joke is fine', at: now.toISOString() },
    }),
  ];
  const { eligible, skipped } = eligibleForPublish(clips, now, 10);
  expect(eligible.map((c) => c.id)).toEqual(['e']);
  expect(skipped).toEqual([]);
});

it('eligibleForPublish enforces the daily cap using only non-dry-run publishes from the last 24h', () => {
  const now = new Date('2026-09-26T12:00:00.000Z');
  const recentPublish = { videoId: 'v0', privacy: 'private', at: new Date(now.getTime() - 3600_000).toISOString(), dryRun: false };
  const stalePublish = { videoId: 'v-1', privacy: 'private', at: new Date(now.getTime() - 30 * 3600_000).toISOString(), dryRun: false };
  const clips = [
    clip({ id: 'published-recent', status: 'published', publish: recentPublish }),
    clip({ id: 'published-stale', status: 'published', publish: stalePublish }),
    clip({ id: 'x', status: 'approved', qc: { ok: true, checks: [], fixesApplied: [], at: '' } }),
    clip({ id: 'y', status: 'approved', qc: { ok: true, checks: [], fixesApplied: [], at: '' } }),
    clip({ id: 'z', status: 'approved', qc: { ok: true, checks: [], fixesApplied: [], at: '' } }),
  ];
  // cap 2, minus 1 published in the last 24h (the stale one doesn't count) = 1 remaining slot.
  const { eligible, skipped } = eligibleForPublish(clips, now, 2);
  expect(eligible.map((c) => c.id)).toEqual(['x']);
  expect(skipped.find((s) => s.id === 'y')?.reason).toMatch(/cap/i);
  expect(skipped.find((s) => s.id === 'z')?.reason).toMatch(/cap/i);
});

it('parseDailyCap defaults to 10 when the config value is missing or blank', () => {
  expect(parseDailyCap(undefined)).toBe(10);
  expect(parseDailyCap('')).toBe(10);
  expect(parseDailyCap('   ')).toBe(10);
});

it('parseDailyCap honors an explicit 0 (publishing paused) instead of falling back to 10', () => {
  expect(parseDailyCap('0')).toBe(0);
});

it('parseDailyCap accepts a normal positive value', () => {
  expect(parseDailyCap('5')).toBe(5);
});

it('parseDailyCap throws a clear config error for a negative value', () => {
  expect(() => parseDailyCap('-1')).toThrow(/CB_PUBLISH_DAILY_CAP/);
});

it('parseDailyCap throws a clear config error for a non-numeric value', () => {
  expect(() => parseDailyCap('abc')).toThrow(/CB_PUBLISH_DAILY_CAP/);
});

it('a daily cap of 0 makes eligibleForPublish skip every candidate as cap-reached', () => {
  const now = new Date('2026-09-26T12:00:00.000Z');
  const clips = [clip({ id: 'x', status: 'approved', qc: { ok: true, checks: [], fixesApplied: [], at: '' } })];
  const { eligible, skipped } = eligibleForPublish(clips, now, 0);
  expect(eligible).toEqual([]);
  expect(skipped[0].reason).toMatch(/cap/i);
});

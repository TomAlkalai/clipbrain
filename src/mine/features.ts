import type { Word, RefShort, Alignment, ShortFeatures } from '../types.js';

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// YYYYMMDD (as returned by yt-dlp's upload_date) -> UTC midnight Date, or null if malformed.
function parseUploadDate(d: string): Date | null {
  if (!/^\d{8}$/.test(d)) return null;
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(4, 6)) - 1;
  const day = Number(d.slice(6, 8));
  const dt = new Date(Date.UTC(y, m, day));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

// Per-channel performance normalization: value = ln(views / median(eligible views in that channel group)).
// Eligible = views > 0 and (uploadDate is empty, or age >= minAgeDays) -- young shorts are excluded
// both from the returned map and from the median pool, since their view counts haven't settled yet.
export function perfScores(shorts: RefShort[], now: Date, minAgeDays = 7): Map<string, number> {
  const groups = new Map<string, RefShort[]>();
  for (const s of shorts) {
    const arr = groups.get(s.channelUrl);
    if (arr) arr.push(s);
    else groups.set(s.channelUrl, [s]);
  }

  const result = new Map<string, number>();
  for (const group of groups.values()) {
    const eligible = group.filter((s) => {
      if (s.views <= 0) return false;
      if (s.uploadDate === '') return true;
      const d = parseUploadDate(s.uploadDate);
      if (!d) return false; // malformed, non-empty date -- can't establish age, so exclude
      const ageDays = (now.getTime() - d.getTime()) / 86400000;
      return ageDays >= minAgeDays;
    });
    if (eligible.length === 0) continue;
    const med = median(eligible.map((s) => s.views));
    for (const s of eligible) {
      result.set(s.id, Math.log(s.views / med));
    }
  }
  return result;
}

export function shortFeatures(
  short: RefShort,
  al: Alignment,
  ep: { words: Word[]; durationSec: number },
  perf: number,
  shortWords: Word[]
): ShortFeatures {
  const segments = al.segments;
  const nSegments = segments.length;
  const srcSpanSec = segments.reduce((sum, s) => sum + (s.srcEnd - s.srcStart), 0);
  const coldOpen = nSegments >= 2 && segments[0].srcStart > segments[1].srcStart + 1;

  const maxSrcEnd = Math.max(...segments.map((s) => s.srcEnd));
  const minSrcStart = Math.min(...segments.map((s) => s.srcStart));
  const tightened = !coldOpen && (maxSrcEnd - minSrcStart - srcSpanSec > 2 || nSegments >= 3);

  // last episode word ending before (earliest source start + 0.05)
  const lastWordBefore = [...ep.words].reverse().find((w) => w.end < minSrcStart + 0.05);
  const startsAfterPause = lastWordBefore ? minSrcStart - lastWordBefore.end >= 0.4 : true;

  const positionInEpisode = ep.durationSec > 0 ? minSrcStart / ep.durationSec : 0;

  const lastShortWordEnd = shortWords.length > 0 ? shortWords[shortWords.length - 1].end : 0;
  const durationSec = short.durationSec || lastShortWordEnd;

  const text = shortWords
    .slice(0, 150)
    .map((w) => w.w.trim())
    .join(' ');
  const contextBefore = ep.words
    .filter((w) => w.start >= minSrcStart - 20 && w.start < minSrcStart)
    .map((w) => w.w.trim())
    .join(' ');

  return {
    shortId: al.shortId,
    episodeId: al.episodeId,
    title: short.title,
    views: short.views,
    perf,
    durationSec,
    srcSpanSec,
    nSegments,
    coldOpen,
    tightened,
    startsAfterPause,
    positionInEpisode,
    text,
    contextBefore,
  };
}

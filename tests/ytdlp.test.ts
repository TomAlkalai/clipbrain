import { it, expect } from 'vitest';
import { mapFlatEntries, downloadSectionArgs } from '../src/yt/ytdlp.js';
it('maps flat playlist entries', () => {
  const c = 'https://www.youtube.com/@X';
  expect(mapFlatEntries({ entries: [
    { id: 'a', title: 'T', view_count: 10, duration: 31, upload_date: '20260101' },
    { id: 'b', title: 'U', view_count: null }] }, c)).toEqual([
    { id: 'a', title: 'T', views: 10, durationSec: 31, uploadDate: '20260101', channelUrl: c },
    { id: 'b', title: 'U', views: 0, durationSec: 0, uploadDate: '', channelUrl: c }]);
});

// ---- Bug 2 follow-up: downloadSection must be robust to an existing output file ----
// ensureHires now always downloads to a fresh temp path (src/render/render.ts,
// fetchAndReplaceHires), so this mostly can't collide in practice any more — but downloadSection
// itself should not silently no-op ("has already been downloaded") if it's ever handed a path
// that happens to already exist, so `--force-overwrites` is passed unconditionally.
it('downloadSectionArgs always includes --force-overwrites, so yt-dlp never skips an existing output file', () => {
  const args = downloadSectionArgs('https://youtu.be/x', 10, 20, 'C:/tmp/hires.mp4');
  expect(args).toContain('--force-overwrites');
  expect(args).toContain('--download-sections');
  expect(args).toContain('*10-20');
  expect(args[args.length - 1]).toBe('https://youtu.be/x');
  expect(args).toContain('C:/tmp/hires.mp4');
});

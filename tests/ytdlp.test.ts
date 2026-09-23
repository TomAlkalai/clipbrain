import { it, expect } from 'vitest';
import { mapFlatEntries } from '../src/yt/ytdlp.js';
it('maps flat playlist entries', () => {
  const c = 'https://www.youtube.com/@X';
  expect(mapFlatEntries({ entries: [
    { id: 'a', title: 'T', view_count: 10, duration: 31, upload_date: '20260101' },
    { id: 'b', title: 'U', view_count: null }] }, c)).toEqual([
    { id: 'a', title: 'T', views: 10, durationSec: 31, uploadDate: '20260101', channelUrl: c },
    { id: 'b', title: 'U', views: 0, durationSec: 0, uploadDate: '', channelUrl: c }]);
});

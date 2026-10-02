import { it, expect } from 'vitest';
import { assembleDataset, transcriptStats, benchSentences } from '../src/bench/dataset.js';
import { foldOf } from '../src/bench/folds.js';
import type { Alignment, ShortFeatures, RefShort, Word } from '../src/types.js';

const seg = (srcStart: number, srcEnd: number) => ({ shortStart: 0, shortEnd: srcEnd - srcStart, srcStart, srcEnd, tokens: 20 });
const al = (shortId: string, episodeId: string, segments = [seg(100, 160)]): Alignment => ({ shortId, episodeId, segments, coverage: 0.9, hits: 20 });
const feat = (shortId: string, episodeId: string, perf: number): ShortFeatures => ({
  shortId, episodeId, title: `Title ${shortId}`, views: 1, perf, durationSec: 60, srcSpanSec: 60, nSegments: 1,
  coldOpen: false, tightened: false, startsAfterPause: true, positionInEpisode: 0.1, text: `opening words of ${shortId}`, contextBefore: '',
});
const short = (id: string): RefShort => ({ id, title: `Short ${id}`, views: 5, uploadDate: '20260901', durationSec: 60, channelUrl: 'c' });
const punctuated: Word[] = 'This is one. And this is two? Yes!'.split(' ').map((w, i) => ({ w, start: i, end: i + 0.8 }));
const bare: Word[] = Array.from({ length: 100 }, (_, i) => ({ w: `w${i}`, start: i * 0.5, end: i * 0.5 + 0.4 }));

it('transcriptStats measures punctuation and picks gap segmentation below 2 %', () => {
  expect(transcriptStats(punctuated)).toMatchObject({ words: 8, punctuationDensity: 3 / 8, segmentation: 'punctuation', sentences: 3 });
  expect(transcriptStats(bare)).toMatchObject({ words: 100, punctuationDensity: 0, segmentation: 'gaps' });
});

it('benchSentences uses tighter gap/length splits for unpunctuated transcripts', () => {
  expect(benchSentences(bare, 'gaps').every((s) => s.w1 - s.w0 + 1 <= 30)).toBe(true);
  expect(benchSentences(punctuated, 'punctuation').map((s) => s.text)).toEqual(['This is one.', 'And this is two?', 'Yes!']);
});

it('assembleDataset groups official moments per episode with grades, folds, youth and transcript stats', () => {
  const ds = assembleDataset({
    slug: 'doac',
    alignments: [al('s1', 'ep1'), al('s2', 'ep1', [seg(2000, 2005), seg(300, 340)]), al('s3', 'ep2'), al('s4', 'ep3', [])],
    features: [feat('s1', 'ep1', 1.0), feat('s3', 'ep2', -0.4)], // s2 too young for a perf score
    shorts: [short('s1'), short('s2'), short('s3')],
    episodeMeta: new Map([['ep1', { title: 'Episode One', durationSec: 5400, uploadDate: '20260601' }], ['ep2', { title: 'Episode Two', durationSec: 3600, uploadDate: '20260920' }]]),
    wordsByEpisode: new Map([['ep1', punctuated], ['ep2', null]]),
    minedAt: new Date('2026-09-28T00:00:00Z'),
    folds: 3,
    minAgeDays: 21,
    createdAt: '2026-09-29T00:00:00Z',
  });
  expect(ds.episodes.map((e) => e.episodeId)).toEqual(['ep1', 'ep2']); // ep3 has no usable segments
  const [ep1, ep2] = ds.episodes;
  expect(ep1).toMatchObject({ title: 'Episode One', durationSec: 5400, fold: foldOf('ep1', 3), young: false });
  expect(ep1.moments.map((m) => [m.shortId, m.title, m.perf, m.grade])).toEqual([['s1', 'Title s1', 1.0, 3], ['s2', 'Short s2', null, 1]]);
  expect(ep1.moments[1].segments).toEqual([{ start: 2000, end: 2005 }, { start: 300, end: 340 }]);
  expect(ep1.heldOut.map((h) => h.shortId)).toEqual(['s1', 's2']);
  expect(ep1.transcript).toMatchObject({ words: 8, segmentation: 'punctuation' });
  expect(ep2).toMatchObject({ young: true, transcript: null });
  expect(ds.summary).toMatchObject({ episodes: 2, moments: 3, young: 1, missingTranscripts: 1 });
});

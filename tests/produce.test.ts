import { it, expect } from 'vitest';
import { attribution, planClip, pickNewEpisodes } from '../src/produce.js';
import type { Source, Creator, Candidate, Sentence, RefShort } from '../src/types.js';
import type { GeneratedHooks } from '../src/hooks/hooks.js';

const source: Source = {
  id: 'src_test1234',
  creator: 'doac',
  kind: 'youtube',
  url: 'https://www.youtube.com/watch?v=abc123',
  videoId: 'abc123',
  title: 'The Man That Makes Millionaires',
  durationSec: 11637,
  width: 3840,
  height: 2160,
  createdAt: '2026-09-23T18:38:43.516Z',
};

const creator: Creator = {
  slug: 'doac',
  name: 'The Diary Of A CEO',
  channelUrl: 'https://www.youtube.com/@TheDiaryOfACEO',
  referenceShortsUrls: [],
  clippingPermission: 'Creator publicly encourages clipping; attribution + link in every description',
  createdAt: '2026-09-23T17:29:11.714Z',
};

// ---- attribution ----

it('attribution formats the source title, creator name and full-episode url', () => {
  expect(attribution(source, creator)).toBe(
    '\n\nFrom "The Man That Makes Millionaires" — The Diary Of A CEO\n' +
      'Full episode: https://www.youtube.com/watch?v=abc123',
  );
});

it('attribution falls back to an empty url when the source has none', () => {
  const fileSource: Source = { ...source, kind: 'file', url: undefined, filePath: 'C:\\video.mp4' };
  expect(attribution(fileSource, creator)).toBe(
    '\n\nFrom "The Man That Makes Millionaires" — The Diary Of A CEO\nFull episode: ',
  );
});

// ---- planClip ----

const sent = (id: number, start: number, end: number): Sentence => ({ id, text: `s${id}`, start, end, w0: id * 2, w1: id * 2 + 1 });
const sentences: Sentence[] = Array.from({ length: 30 }, (_, i) => sent(i, i * 10, i * 10 + 3));

const candidate: Candidate = {
  id: 'cand_abc123',
  sourceId: source.id,
  startSid: 5,
  endSid: 10,
  start: 50,
  end: 103,
  title: 'candidate title',
  summary: 'candidate summary',
  why: 'a sharp contrarian claim with a concrete payoff',
  patterns: ['contrarian'],
  scores: {
    hook: { score: 8, reason: 'r' },
    standalone_clarity: { score: 8, reason: 'r' },
    payoff: { score: 7, reason: 'r' },
    novelty: { score: 6, reason: 'r' },
    emotional_intensity: { score: 5, reason: 'r' },
    information_density: { score: 8, reason: 'r' },
    audience_fit: { score: 9, reason: 'r' },
  },
  composite: 7.29,
  rank: 1,
  rankReason: 'top pick',
  shortlisted: true,
  visual: { score: 8, metrics: { faceCoverage: 0.9, twoShotRatio: 0, fitRatio: 0.1, cutsPerMin: 4, medianFaceH: 0.3, longestNoFaceSec: 1 }, issues: [] },
  boundary: { openingStandalone: true, endingComplete: true, repaired: false, notes: 'fine' },
};

const gen: GeneratedHooks = {
  hooks: [
    { text: 'Hook A', pattern: 'contrarian', score: 9 },
    { text: 'Hook B', pattern: 'question', score: 7 },
  ],
  title: 'Generated title',
  description: 'Generated description.',
  hashtags: ['business', 'money'],
  coldOpenSid: 7,
  coldOpenReason: 'sentence 7 is the most gripping line',
};

it('planClip sets status planned, hookIndex 0 and renders 0', () => {
  const clip = planClip(source, creator, candidate, gen, sentences);
  expect(clip.status).toBe('planned');
  expect(clip.hookIndex).toBe(0);
  expect(clip.renders).toBe(0);
});

it('planClip takes start/end from the candidate and hooks/title/hashtags from gen', () => {
  const clip = planClip(source, creator, candidate, gen, sentences);
  expect(clip.start).toBe(candidate.start);
  expect(clip.end).toBe(candidate.end);
  expect(clip.hooks).toEqual(gen.hooks);
  expect(clip.title).toBe(gen.title);
  expect(clip.hashtags).toEqual(gen.hashtags);
});

it('planClip builds coldOpen from the sentence at coldOpenSid, padded -0.1s/+0.2s', () => {
  const clip = planClip(source, creator, candidate, gen, sentences);
  const s = sentences[7]; // start 70, end 73
  expect(clip.coldOpen).toEqual({ start: s.start - 0.1, end: s.end + 0.2 });
});

it('planClip leaves coldOpen null when coldOpenSid is null', () => {
  const noColdOpen: GeneratedHooks = { ...gen, coldOpenSid: null };
  const clip = planClip(source, creator, candidate, noColdOpen, sentences);
  expect(clip.coldOpen).toBeNull();
});

it("planClip's description is gen.description followed by the attribution block", () => {
  const clip = planClip(source, creator, candidate, gen, sentences);
  expect(clip.description).toBe(gen.description + attribution(source, creator));
});

it('planClip copies rank/why/visual/boundary from the candidate', () => {
  const clip = planClip(source, creator, candidate, gen, sentences);
  expect(clip.rank).toBe(candidate.rank);
  expect(clip.why).toBe(candidate.why);
  expect(clip.visual).toEqual(candidate.visual);
  expect(clip.boundary).toEqual(candidate.boundary);
});

it('planClip sets candidateId, sourceId and creator from the source/candidate', () => {
  const clip = planClip(source, creator, candidate, gen, sentences);
  expect(clip.candidateId).toBe(candidate.id);
  expect(clip.sourceId).toBe(source.id);
  expect(clip.creator).toBe(source.creator);
});

it('planClip generates a fresh clip id each time', () => {
  const a = planClip(source, creator, candidate, gen, sentences);
  const b = planClip(source, creator, candidate, gen, sentences);
  expect(a.id).not.toBe(b.id);
  expect(a.id).toMatch(/^clip_/);
});

// ---- pickNewEpisodes (pure scout filter) ----

const ep = (id: string, durationSec: number): RefShort => ({
  id,
  title: `episode ${id}`,
  views: 1000,
  uploadDate: '20260101',
  durationSec,
  channelUrl: 'https://www.youtube.com/@TheDiaryOfACEO',
});

it('pickNewEpisodes keeps only long-enough episodes not already ingested', () => {
  const list = [ep('a', 1200), ep('b', 300), ep('c', 950)];
  const picked = pickNewEpisodes(list, new Set(), 3, 900);
  expect(picked.map((e) => e.id)).toEqual(['a', 'c']);
});

it('pickNewEpisodes drops episodes whose videoId already has a source', () => {
  const list = [ep('a', 1200), ep('b', 1200), ep('c', 1200)];
  const picked = pickNewEpisodes(list, new Set(['b']), 3, 900);
  expect(picked.map((e) => e.id)).toEqual(['a', 'c']);
});

it('pickNewEpisodes returns at most `latest`, preserving (already newest-first) order', () => {
  const list = [ep('a', 1200), ep('b', 1200), ep('c', 1200), ep('d', 1200)];
  const picked = pickNewEpisodes(list, new Set(), 2, 900);
  expect(picked.map((e) => e.id)).toEqual(['a', 'b']);
});

it('pickNewEpisodes defaults minDur to 900s when omitted', () => {
  const list = [ep('a', 899), ep('b', 900)];
  const picked = pickNewEpisodes(list, new Set(), 5);
  expect(picked.map((e) => e.id)).toEqual(['b']);
});

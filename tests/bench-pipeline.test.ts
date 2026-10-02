import { it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The ranking benchmark end to end on a synthetic creator, with a fake LLM backend:
// dataset -> fold playbooks -> pools (production buildPool) -> rank variants -> report.
process.env.CB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-bench-'));
const { setBackend, ledgerSummary } = await import('../src/llm/llm.js');
const { saveCreator, paths, writeJson, readJson } = await import('../src/store.js');
const { buildDataset } = await import('../src/bench/dataset.js');
const { foldOf } = await import('../src/bench/folds.js');
const { buildPools, pilotEpisodes, poolPath } = await import('../src/bench/pools.js');
const { rankVariants, rankingPath, fitWeights, completeRanking } = await import('../src/bench/variants.js');
const { writeReport, computeReport, renderReportMd } = await import('../src/bench/report.js');
const { SIGNALS } = await import('../src/types.js');
const { DATA } = await import('../src/config.js');
import type { Candidate } from '../src/types.js';

const SLUG = 'synth';
// Two episodes per fold (2 folds): pick ids by their hash so both folds are populated.
const ids: string[] = [];
for (let i = 0; ids.filter((x) => foldOf(x, 2) === 0).length < 2 || ids.filter((x) => foldOf(x, 2) === 1).length < 2; i++) {
  const id = `ep${i}`;
  if (ids.filter((x) => foldOf(x, 2) === foldOf(id, 2)).length < 2) ids.push(id);
}
// Each episode: 60 sentences x 10 s (4 words each); its official Short covers sentences 30–35.
const words = Array.from({ length: 60 }, (_, i) => [
  { w: 'Real', start: i * 10, end: i * 10 + 1 }, { w: 'mid', start: i * 10 + 1.2, end: i * 10 + 3 },
  { w: 'more', start: i * 10 + 3.2, end: i * 10 + 6 }, { w: 'end.', start: i * 10 + 6.2, end: i * 10 + 9.5 },
]).flat();
const sc = (v: number, hookBoost = 0) => Object.fromEntries(SIGNALS.map((k) => [k, { score: k === 'hook' ? v + hookBoost : v, reason: 'r' }]));
let leakIntoPlaybook = false;
let rankCalls: { model: string; prompt: string; system: string }[] = [];

beforeAll(() => {
  saveCreator({ slug: SLUG, name: 'Synth Creator', channelUrl: 'x', referenceShortsUrls: [], clippingPermission: 'ok', createdAt: '2026-01-01T00:00:00Z' });
  const dir = paths.creator(SLUG);
  const seg = (a: number, b: number) => ({ shortStart: 0, shortEnd: b - a, srcStart: a, srcEnd: b, tokens: 20 });
  writeJson(path.join(dir, 'alignments.json'), ids.map((id) => ({ shortId: `short_${id}`, episodeId: id, segments: [seg(300, 360)], coverage: 1, hits: 20 })));
  // 5 features per episode (distill needs >= 8 out of fold); only the first is the aligned official Short.
  writeJson(path.join(dir, 'features.json'), ids.flatMap((id) => Array.from({ length: 5 }, (_, k) => ({
    shortId: k === 0 ? `short_${id}` : `extra_${id}_${k}`, episodeId: id, title: `Title of ${id} short number ${k} here`, views: 1, perf: 1 - k * 0.3,
    durationSec: 60, srcSpanSec: 60, nSegments: 1, coldOpen: false, tightened: false, startsAfterPause: true, positionInEpisode: 0.5,
    text: `the secret opening line of ${id} short ${k} that nobody else says ever`, contextBefore: '',
  }))));
  writeJson(path.join(dir, 'mine-report.json'), { at: '2026-09-28T00:00:00Z' });
  writeJson(path.join(DATA, 'cache', 'list-x.json'), ids.map((id) => ({ id, title: `Episode ${id}`, views: 1, uploadDate: '20260601', durationSec: 600, channelUrl: 'c' })));
  for (const id of ids) writeJson(path.join(DATA, 'cache', 'subs', `${id}.json`), words);
  buildDataset(SLUG, { folds: 2 });

  setBackend(async ({ model, system, prompt }) => {
    if (system.includes('reverse-engineering')) {
      // Distill: echo one example opening line from the features it was given (out-of-fold only).
      const firstShort = /### (\S+)/.exec(prompt)?.[1] ?? 'none';
      const ep = ids.find((id) => firstShort.includes(id)) ?? ids[0];
      const leakedEp = ids.find((id) => !prompt.includes(`_${id}`)) ?? ids[0]; // an episode NOT in the training set
      const example = leakIntoPlaybook ? `the secret opening line of ${leakedEp} short 0 that nobody else says ever` : `the secret opening line of ${ep} short 1`;
      return { output: { principles: ['p'], hookPatterns: [{ id: 'h', name: 'H', description: 'd', examples: [example] }], structures: [], antiPatterns: [], exemplars: [], idealDurationSec: { min: 20, max: 75 } }, costUsd: 0.5 };
    }
    if (model === 'sonnet' && system.includes('head clip editor')) {
      return { output: { candidates: [
        { startSid: 3, endSid: 6, title: 'early', summary: 's', why: 'w', patterns: [], scores: sc(8) },  // composite 8, not official
        { startSid: 30, endSid: 35, title: 'the one', summary: 's', why: 'w', patterns: [], scores: sc(6, 3) }, // official moment, composite lower
        { startSid: 45, endSid: 50, title: 'late', summary: 's', why: 'w', patterns: [], scores: sc(7) },
      ] }, costUsd: 1 };
    }
    if (model === 'haiku') {
      return { output: { openingStandalone: true, openingIssue: '', newStartSid: null, endingComplete: true, endingIssue: '', newEndSid: null }, costUsd: 0.01 };
    }
    // Final rank (opus, or sonnet for V3): put the candidate titled "the one" first.
    rankCalls.push({ model, prompt, system });
    const lines = [...prompt.matchAll(/^(cand_[a-z0-9]{8}) \|[^\n]*\| ([^|\n]+)$/gm)].map((m) => ({ id: m[1], title: m[2].trim() }));
    const sorted = [...lines].sort((a, b) => Number(b.title === 'the one') - Number(a.title === 'the one'));
    return { output: { ranking: [{ id: 'cand_bogus123', reason: 'x' }, ...sorted.map((l) => ({ id: l.id, reason: 'r' }))] }, costUsd: 0.2 };
  });
});

it('the leakage guard stops a fold playbook that contains a held-out Short', async () => {
  leakIntoPlaybook = true;
  await expect(buildPools(SLUG, { pilot: true, maxUsd: 100 })).rejects.toThrow(/benchmark leakage in fold \d playbook/);
  leakIntoPlaybook = false;
  // Forget the leaky distill: both the fold-playbook file and the LLM disk cache entry.
  fs.rmSync(path.join(DATA, 'bench', SLUG, 'playbooks'), { recursive: true, force: true });
  fs.rmSync(path.join(DATA, '.llm-cache'), { recursive: true, force: true });
});

it('pilot picks one episode per fold and builds their pools; a re-run reuses them for free', async () => {
  const ds = readJson<any>(path.join(DATA, 'bench', SLUG, 'dataset.json'));
  expect(pilotEpisodes(ds).map((e: any) => e.fold).sort()).toEqual([0, 1]);
  const r = await buildPools(SLUG, { pilot: true, maxUsd: 100 });
  expect(r.built).toHaveLength(2);
  expect(r.failed).toBeNull();
  const pool = readJson<any>(poolPath(SLUG, r.built[0]));
  expect(pool.pool.map((c: Candidate) => c.title)).toEqual(['early', 'late', 'the one']); // by composite
  expect(pool.costUsd).toBeGreaterThan(0);
  const again = await buildPools(SLUG, { pilot: true, maxUsd: 100 });
  expect(again).toMatchObject({ built: [], cached: r.built });
});

it('the --max-usd cap is cumulative across runs and stops cleanly before the next episode', async () => {
  const rest = ids.filter((id) => !fs.existsSync(poolPath(SLUG, id)));
  const already = await buildPools(SLUG, { maxUsd: 0.5 }); // the pilot alone already spent more than this
  expect(already).toMatchObject({ stoppedForBudget: true, built: [] });
  expect(already.totalUsd).toBeGreaterThan(0.5);
  const oneMore = await buildPools(SLUG, { maxUsd: already.totalUsd + 0.5 }); // room for one more episode only
  expect(oneMore.built).toHaveLength(1);
  expect(oneMore.stoppedForBudget).toBe(true);
  expect(rest.filter((id) => fs.existsSync(poolPath(SLUG, id)))).toHaveLength(1);
});

it('rank variants: V0 follows the ranker (bogus ids dropped), V1 hides scores, V2 drops audience examples, no leaks', async () => {
  await buildPools(SLUG, { maxUsd: 100 }); // the remaining two episodes
  rankCalls = [];
  const r = await rankVariants(SLUG, { variants: ['V0', 'V1', 'V2', 'V3', 'B-comp', 'W-cv'], repeats: 1 });
  expect(r.failed).toBeNull();
  const v0 = readJson<any>(rankingPath(SLUG, 'V0', ids[0]));
  const pool = readJson<any>(poolPath(SLUG, ids[0])).pool as Candidate[];
  expect(pool.find((c) => c.id === v0.ranked[0])!.title).toBe('the one');
  expect(v0.ranked).toHaveLength(pool.length);
  expect(fs.existsSync(rankingPath(SLUG, 'V0@r1', ids[0]))).toBe(true);
  expect(readJson<any>(rankingPath(SLUG, 'B-comp', ids[0])).ranked[0]).toBe(pool[0].id);
  const v1 = rankCalls.find((c) => !c.prompt.includes('scores:'));
  expect(v1?.system).not.toContain('per-signal scores');
  expect(rankCalls.some((c) => c.model === 'sonnet')).toBe(true); // V3
  const v2 = rankCalls.filter((c) => !c.prompt.includes("What this channel's audience responded to most"));
  expect(v2.length).toBeGreaterThan(0);
  // Out-of-fold audience examples: with 2 folds, every prompt's titles come from exactly one fold
  // (the other one) — a prompt mixing both folds would mean an episode saw its own fold's Shorts.
  const withAudience = rankCalls.filter((c) => c.prompt.includes("What this channel's audience responded to most"));
  expect(withAudience.length).toBeGreaterThan(0);
  for (const c of withAudience) {
    const foldsSeen = new Set(ids.filter((id) => c.prompt.includes(`Title of ${id} short`)).map((id) => foldOf(id, 2)));
    expect(foldsSeen.size).toBe(1);
  }
});

it('W-cv learns to boost the signal that finds the official moment', () => {
  const moments = [{ shortId: 's', title: 's', perf: 1, grade: 3 as const, segments: [{ start: 300, end: 360 }] }];
  const mk = (id: string, start: number, hook: number, other: number): Candidate => ({
    id, sourceId: 'x', startSid: 0, endSid: 0, start, end: start + 60, title: id, summary: '', why: '', patterns: [], shortlisted: false,
    scores: Object.fromEntries(SIGNALS.map((s) => [s, { score: s === 'hook' ? hook : other, reason: '' }])) as Candidate['scores'], composite: 0,
  });
  const train = [0, 1].map(() => ({ pool: [mk('a', 0, 5, 9), mk('b', 300, 9, 6), mk('c', 500, 5, 8)], moments }));
  expect(fitWeights(train).hook).toBeGreaterThan(1);
  expect(completeRanking([mk('a', 0, 5, 9), mk('b', 300, 9, 6)], ['b', 'zzz', 'b'])).toEqual(['b', 'a']);
});

it('report: V0 beats composite on this data, decision rule columns present, written to disk', () => {
  const report = writeReport(SLUG);
  const v0 = report.variants.find((v) => v.key === 'V0')!;
  const comp = report.variants.find((v) => v.key === 'B-comp')!;
  expect(v0.metrics.ndcgPool.mean).toBeCloseTo(1);
  expect(comp.metrics.ndcgPool.mean).toBeLessThan(1);
  expect(report.noiseFloor).toBe(0);
  expect(report.comparisons.find((c) => c.key === 'B-comp')!.promote).toBe(false);
  expect(report.pools.episodes).toBe(4);
  expect(report.pools.poolRecall.mean).toBe(1);
  const md = fs.readFileSync(path.join(DATA, 'bench', SLUG, 'report', 'report.md'), 'utf8');
  for (const h of ['## Candidate pools', '## Variants', '## Against the production ranker', '## Which first-pass signals', '## Per episode']) expect(md).toContain(h);
  expect(md).toContain('Only 4 episode(s)');
  expect(ledgerSummary().costUsd).toBeGreaterThan(0);
  expect(renderReportMd(computeReport({ ds: { ...readJson<any>(path.join(DATA, 'bench', SLUG, 'dataset.json')) }, pools: new Map(), rankings: new Map(), at: 'x' }))).toContain('V0 has not been run yet');
});

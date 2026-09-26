import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-stats-'));
const stats = await import('../src/metrics/stats.js');
const store = await import('../src/store.js');
import type { Clip } from '../src/types.js';

function makeClip(id: string): Clip {
  const now = new Date().toISOString();
  return {
    id,
    sourceId: 'src',
    creator: 'doac',
    candidateId: 'cand',
    start: 0,
    end: 10,
    coldOpen: null,
    title: 't',
    description: '',
    hashtags: [],
    hooks: [{ text: 't', pattern: 'x', score: 0 }],
    hookIndex: 0,
    scores: {} as any,
    composite: 5,
    rankReason: '',
    patterns: [],
    hiresOffset: 0,
    status: 'published',
    renders: 1,
    createdAt: now,
    updatedAt: now,
  } as Clip;
}

describe('parseStatsCsv', () => {
  it('parses valid rows', () => {
    const csv = 'clipId,views,avgViewPct\nclip_a,1000,45.5\nclip_b,0,100\n';
    const { rows, errors } = stats.parseStatsCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { line: 2, raw: 'clip_a,1000,45.5', clipId: 'clip_a', views: 1000, avgViewPct: 45.5 },
      { line: 3, raw: 'clip_b,0,100', clipId: 'clip_b', views: 0, avgViewPct: 100 },
    ]);
  });

  it('allows avgViewPct to be omitted', () => {
    const csv = 'clipId,views,avgViewPct\nclip_a,1000\n';
    const { rows, errors } = stats.parseStatsCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toEqual([{ line: 2, raw: 'clip_a,1000', clipId: 'clip_a', views: 1000, avgViewPct: undefined }]);
  });

  it('rejects a non-numeric or negative views value instead of producing NaN', () => {
    const csv = 'clipId,views,avgViewPct\nclip_bad,not-a-number,50\nclip_neg,-5,50\nclip_ok,10,50\n';
    const { rows, errors } = stats.parseStatsCsv(csv);
    expect(rows).toEqual([{ line: 4, raw: 'clip_ok,10,50', clipId: 'clip_ok', views: 10, avgViewPct: 50 }]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toEqual({ line: 2, raw: 'clip_bad,not-a-number,50', message: expect.stringContaining('views must be a finite number') });
    expect(errors[1].message).toContain('views must be a finite number');
  });

  it('rejects an out-of-range or non-numeric avgViewPct', () => {
    const csv = 'clipId,views,avgViewPct\nclip_over,10,150\nclip_nan,10,oops\nclip_ok,10,50\n';
    const { rows, errors } = stats.parseStatsCsv(csv);
    expect(rows).toEqual([{ line: 4, raw: 'clip_ok,10,50', clipId: 'clip_ok', views: 10, avgViewPct: 50 }]);
    expect(errors).toHaveLength(2);
    expect(errors[0].message).toContain('avgViewPct must be a finite number 0-100');
    expect(errors[1].message).toContain('avgViewPct must be a finite number 0-100');
  });
});

describe('importCsv / importCsvDetailed', () => {
  beforeEach(() => {
    store.saveClip(makeClip('clip_good'));
  });
  afterEach(() => {
    process.exitCode = undefined;
  });

  it('skips invalid rows, writes only the valid ones, and reports errors', async () => {
    const csvPath = path.join(process.env.CB_DATA!, 'import.csv');
    fs.writeFileSync(csvPath, 'clipId,views,avgViewPct\nclip_good,5000,60\nclip_good,not-a-number,60\n');

    const result = await stats.importCsvDetailed(csvPath);
    expect(result.updated).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('views must be a finite number');

    const reloaded = store.loadClip('clip_good');
    expect(reloaded.metrics).toHaveLength(1);
    expect(reloaded.metrics![0]).toMatchObject({ views: 5000, avgViewPct: 60, source: 'csv' });
  });

  it('importCsv keeps returning a plain count but sets a non-zero exit code when a row was invalid', async () => {
    const csvPath = path.join(process.env.CB_DATA!, 'import2.csv');
    fs.writeFileSync(csvPath, 'clipId,views,avgViewPct\nclip_good,100,10\nclip_missing,200,20\n');

    process.exitCode = undefined;
    const n = await stats.importCsv(csvPath);
    expect(n).toBe(1); // clip_missing doesn't exist -> reported as an error, not written
    expect(process.exitCode).toBe(1);
  });

  it('importCsv leaves the exit code alone when every row is valid', async () => {
    const csvPath = path.join(process.env.CB_DATA!, 'import3.csv');
    fs.writeFileSync(csvPath, 'clipId,views,avgViewPct\nclip_good,100,10\n');

    process.exitCode = undefined;
    const n = await stats.importCsv(csvPath);
    expect(n).toBe(1);
    expect(process.exitCode).toBeUndefined();
  });
});

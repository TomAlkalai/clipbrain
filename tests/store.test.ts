import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
process.env.CB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-'));
const store = await import('../src/store.js');
describe('store', () => {
  it('writes atomically and reads back', () => {
    const p = path.join(process.env.CB_DATA!, 'a/b/c.json');
    store.writeJson(p, { x: 1 });
    expect(store.readJson(p)).toEqual({ x: 1 });
    expect(fs.existsSync(p + '.tmp')).toBe(false);
  });
  it('readJsonOr returns default for missing file', () => {
    expect(store.readJsonOr(path.join(process.env.CB_DATA!, 'nope.json'), [])).toEqual([]);
  });
  it('newId has prefix and is unique', () => {
    const a = store.newId('clip'), b = store.newId('clip');
    expect(a).toMatch(/^clip_[a-z0-9]{8}$/); expect(a).not.toBe(b);
  });
});

import { it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { startStaticServer } from '../src/render/static.js';
import { parseLoudnorm } from '../src/render/render.js';
it('serves byte ranges', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-')); fs.writeFileSync(path.join(d, 'a.mp4'), Buffer.from('0123456789'));
  const s = await startStaticServer(d);
  const r = await fetch(`${s.url}/a.mp4`, { headers: { Range: 'bytes=2-5' } });
  expect(r.status).toBe(206); expect(await r.text()).toBe('2345'); expect(r.headers.get('content-range')).toBe('bytes 2-5/10');
  expect((await fetch(`${s.url}/../x`)).status).toBeGreaterThanOrEqual(400);
  await s.close();
});
it('parses loudnorm json', () => {
  const e = 'blah\n[Parsed_loudnorm_0 @ 0x]\n{\n"input_i" : "-20.51",\n"input_tp" : "-3.20",\n"input_lra" : "5.10",\n"input_thresh" : "-30.9",\n"target_offset" : "0.3"\n}\n';
  expect(parseLoudnorm(e)).toEqual({ input_i: -20.51, input_tp: -3.2, input_lra: 5.1, input_thresh: -30.9, target_offset: 0.3 });
});

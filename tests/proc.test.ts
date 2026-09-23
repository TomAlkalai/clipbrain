import { it, expect } from 'vitest';
import { run, runOk } from '../src/tools/proc.js';
it('captures stdout and exit code', async () => {
  const r = await run(process.execPath, ['-e', 'process.stdout.write("hi");process.exit(3)']);
  expect(r).toMatchObject({ code: 3, stdout: 'hi' });
});
it('runOk throws with stderr on failure', async () => {
  await expect(runOk(process.execPath, ['-e', 'console.error("boom");process.exit(1)'])).rejects.toThrow(/boom/);
});
it('passes stdin', async () => {
  const r = await run(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'abc' });
  expect(r.stdout).toBe('abc');
});

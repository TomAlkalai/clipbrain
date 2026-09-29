import { it, expect } from 'vitest';
import { run, runOk, isIgnorableKillEperm } from '../src/tools/proc.js';
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

// ---- Bug 3 (important): a renderer failure kills the whole CLI ----
// Root cause: after a render error (e.g. Bug 1's crash), @remotion/renderer's browser/compositor
// teardown emits an 'error' event (code EPERM, syscall 'kill') on a Windows ChildProcess with no
// 'error' listener attached — Node re-emits an unlistened 'error' event as an uncaughtException,
// which crashes the whole process before the per-clip try/catch in produce/requalify ever runs,
// abandoning every remaining clip. src/cli.ts's main() registers global uncaughtException/
// unhandledRejection handlers that swallow ONLY this exact error shape (logging a one-line
// warning) and let per-clip error handling keep working; everything else still exits non-zero.
it('isIgnorableKillEperm: true for the exact EPERM/kill shape emitted by @remotion/renderer teardown on Windows', () => {
  expect(isIgnorableKillEperm(Object.assign(new Error('kill EPERM'), { code: 'EPERM', syscall: 'kill' }))).toBe(true);
});
it('isIgnorableKillEperm: false when the code is EPERM but the syscall is not kill', () => {
  expect(isIgnorableKillEperm(Object.assign(new Error('EPERM'), { code: 'EPERM', syscall: 'unlink' }))).toBe(false);
});
it('isIgnorableKillEperm: false when the syscall is kill but the code is not EPERM', () => {
  expect(isIgnorableKillEperm(Object.assign(new Error('kill'), { code: 'ESRCH', syscall: 'kill' }))).toBe(false);
});
it('isIgnorableKillEperm: false for an ordinary Error with no code/syscall', () => {
  expect(isIgnorableKillEperm(new Error('render failed: inputRange must be strictly monotonically increasing'))).toBe(false);
});
it('isIgnorableKillEperm: false for non-error values (string, undefined, null, plain object)', () => {
  expect(isIgnorableKillEperm('EPERM')).toBe(false);
  expect(isIgnorableKillEperm(undefined)).toBe(false);
  expect(isIgnorableKillEperm(null)).toBe(false);
  expect(isIgnorableKillEperm({})).toBe(false);
});

import { it, expect, afterEach } from 'vitest';
import { withRenderWatchdog, RenderTimeoutError, parseRenderTimeouts } from '../src/render/watchdog.js';

// HANDOFF open item #2: `produce` sat for 5 days on clip_4v1cw97c with headless Chrome open —
// Remotion waited forever after losing its connection. The watchdog bounds the Chrome phase: it
// fails when no progress arrives for `stallMs`, or when `hardMs` passes regardless, runs the
// cleanup (cancel Remotion, kill Chrome) with its own bound, and never waits on the hung task.
const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => unhandled.push(e);
process.on('unhandledRejection', onUnhandled);
afterEach(() => { expect(unhandled).toEqual([]); });

const never = () => new Promise<never>(() => {});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

it('a task that finishes normally resolves with its value and runs no cleanup', async () => {
  let cleaned = 0;
  const v = await withRenderWatchdog(async () => { await sleep(10); return 42; }, { stallMs: 200, hardMs: 1000, cleanup: async () => { cleaned++; } });
  expect(v).toBe(42);
  await sleep(250); // past both timers: nothing fires late
  expect(cleaned).toBe(0);
});

it('no progress for stallMs: rejects with a stall error, runs cleanup once, ignores the hung task', async () => {
  let cleaned = 0;
  const t0 = Date.now();
  const err = await withRenderWatchdog(() => never(), { stallMs: 60, hardMs: 5000, cleanup: async () => { cleaned++; }, describe: () => 'frame 12/300' })
    .catch((e) => e);
  expect(err).toBeInstanceOf(RenderTimeoutError);
  expect(err.kind).toBe('stall');
  expect(err.message).toMatch(/no render progress for 0\.0 min.*frame 12\/300/);
  expect(Date.now() - t0).toBeLessThan(1000);
  expect(cleaned).toBe(1);
});

it('regular progress keeps a long task alive past stallMs (a normal slow render is not timed out)', async () => {
  const v = await withRenderWatchdog(async ({ progress }) => {
    for (let i = 0; i < 10; i++) { await sleep(25); progress(); }
    return 'done';
  }, { stallMs: 80, hardMs: 5000, cleanup: async () => {} });
  expect(v).toBe('done'); // ran ~250 ms, i.e. 3× stallMs, without timing out
});

it('the hard cap fires even while progress keeps arriving', async () => {
  const err = await withRenderWatchdog(async ({ progress }) => {
    for (;;) { await sleep(10); progress(); }
  }, { stallMs: 1000, hardMs: 80, cleanup: async () => {} }).catch((e) => e);
  expect(err).toBeInstanceOf(RenderTimeoutError);
  expect(err.kind).toBe('hard');
  expect(err.message).toMatch(/exceeded the 0\.0 min render limit/);
});

it('a hung task that later rejects (e.g. after Chrome is killed) never surfaces as an unhandled rejection', async () => {
  let rejectLater!: (e: Error) => void;
  const err = await withRenderWatchdog(() => new Promise<never>((_, rej) => { rejectLater = rej; }), {
    stallMs: 30, hardMs: 1000, cleanup: async () => { setTimeout(() => rejectLater(new Error('Target closed')), 5); },
  }).catch((e) => e);
  expect(err.kind).toBe('stall');
  await sleep(30); // the abandoned task rejects now; afterEach asserts it was swallowed
});

it('cleanup that hangs or throws is bounded and does not replace the timeout error', async () => {
  const hung = await withRenderWatchdog(() => never(), { stallMs: 20, hardMs: 1000, cleanupTimeoutMs: 40, cleanup: () => never() }).catch((e) => e);
  expect(hung).toBeInstanceOf(RenderTimeoutError);
  const thrown = await withRenderWatchdog(() => never(), { stallMs: 20, hardMs: 1000, cleanup: async () => { throw new Error('kill EPERM'); } }).catch((e) => e);
  expect(thrown).toBeInstanceOf(RenderTimeoutError);
  expect(thrown.message).toMatch(/cleanup failed: kill EPERM/);
});

it('a task error is passed through unchanged (no timeout involved)', async () => {
  const err = await withRenderWatchdog(async () => { throw new Error('Failed to fetch'); }, { stallMs: 200, hardMs: 1000, cleanup: async () => {} }).catch((e) => e);
  expect(err).not.toBeInstanceOf(RenderTimeoutError);
  expect(err.message).toBe('Failed to fetch');
});

it('parseRenderTimeouts: minutes from env with defaults; invalid values fall back with a reason', () => {
  expect(parseRenderTimeouts({})).toEqual({ stallMs: 5 * 60_000, hardMs: 60 * 60_000, warnings: [] });
  expect(parseRenderTimeouts({ CB_RENDER_STALL_MIN: '2', CB_RENDER_TIMEOUT_MIN: '30' })).toMatchObject({ stallMs: 2 * 60_000, hardMs: 30 * 60_000 });
  const bad = parseRenderTimeouts({ CB_RENDER_STALL_MIN: 'soon', CB_RENDER_TIMEOUT_MIN: '-1' });
  expect(bad).toMatchObject({ stallMs: 5 * 60_000, hardMs: 60 * 60_000 });
  expect(bad.warnings).toHaveLength(2);
  expect(parseRenderTimeouts({ CB_RENDER_STALL_MIN: '90', CB_RENDER_TIMEOUT_MIN: '30' }).stallMs).toBe(30 * 60_000); // stall never above the cap
});

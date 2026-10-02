import { it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { installCrashGuards, flushStreams } from '../src/tools/crash-guards.js';

// HANDOFF #1: the fatal path used to call process.exit(1) straight after logging, which can drop
// the error line when stderr is a pipe (asynchronous on Windows); and the kill-EPERM ignore was
// also attached to unhandledRejection, where that error shape never legitimately arrives.
type Event = 'uncaughtException' | 'unhandledRejection';
function harness(flush: () => Promise<void> = async () => {}) {
  const handlers: Partial<Record<Event, (err: unknown) => void>> = {};
  const events: string[] = [];
  installCrashGuards({
    on: (event, h) => { handlers[event] = h; },
    log: (...a) => { events.push(`log:${a.map(String).join(' ')}`); },
    flush: async () => { events.push('flush:start'); await flush(); events.push('flush:done'); },
    exit: (code) => { events.push(`exit:${code}`); },
  });
  return { handlers, events };
}
const killEperm = () => Object.assign(new Error('kill EPERM'), { code: 'EPERM', syscall: 'kill' });
const settle = () => new Promise((r) => setImmediate(r));

it('uncaughtException: ignores only the renderer-teardown kill EPERM, with a warning', async () => {
  const { handlers, events } = harness();
  handlers.uncaughtException!(killEperm());
  await settle();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatch(/^log:warning: ignoring EPERM/);
});

it('uncaughtException: any other error logs, flushes output, and only then exits 1', async () => {
  const { handlers, events } = harness();
  handlers.uncaughtException!(new Error('boom'));
  await settle();
  expect(events[0]).toMatch(/^log:error: Error: boom/);
  expect(events.slice(1)).toEqual(['flush:start', 'flush:done', 'exit:1']);
});

it('unhandledRejection: kill EPERM is NOT ignored there — it is fatal like any other rejection', async () => {
  const { handlers, events } = harness();
  handlers.unhandledRejection!(killEperm());
  await settle();
  expect(events[0]).toMatch(/^log:error: .*kill EPERM/);
  expect(events.at(-1)).toBe('exit:1');
});

it('unhandledRejection: non-Error reasons are logged and fatal', async () => {
  const { handlers, events } = harness();
  handlers.unhandledRejection!('plain string reason');
  await settle();
  expect(events).toEqual(['log:error: plain string reason', 'flush:start', 'flush:done', 'exit:1']);
});

it('a second fatal error while flushing does not start a second exit', async () => {
  let release!: () => void;
  const { handlers, events } = harness(() => new Promise<void>((r) => { release = r; }));
  handlers.uncaughtException!(new Error('first'));
  handlers.unhandledRejection!(new Error('second'));
  release();
  await settle();
  expect(events.filter((e) => e.startsWith('exit:'))).toEqual(['exit:1']);
  expect(events.filter((e) => e === 'flush:start')).toHaveLength(1);
  expect(events.some((e) => e.includes('second'))).toBe(true); // still reported
});

it('a failing flush still exits', async () => {
  const { handlers, events } = harness(async () => { throw new Error('EPIPE'); });
  handlers.uncaughtException!(new Error('boom'));
  await settle();
  expect(events.at(-1)).toBe('exit:1');
});

it('flushStreams resolves once every stream has written out what was queued before it', async () => {
  const written: string[] = [];
  const slow = new Writable({ write(chunk, _enc, cb) { setTimeout(() => { written.push(String(chunk)); cb(); }, 5); } });
  slow.write('error line\n');
  await flushStreams([slow], 1000);
  expect(written).toContain('error line\n');
});

it('flushStreams gives up after the timeout when a stream never drains', async () => {
  const stuck = new Writable({ write() { /* never calls back */ } });
  const t0 = Date.now();
  await flushStreams([stuck], 30);
  expect(Date.now() - t0).toBeLessThan(1000);
});

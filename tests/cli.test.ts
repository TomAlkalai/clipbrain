import { it, expect } from 'vitest';
import { parseArgs, asBool } from '../src/cli.js';

it('parses single flags as scalars', () => {
  const p = parseArgs(['creator', 'add', 'doac', '--name', 'The Diary Of A CEO', '--channel', 'https://x']);
  expect(p._).toEqual(['creator', 'add', 'doac']);
  expect(p.flags.name).toBe('The Diary Of A CEO');
  expect(p.flags.channel).toBe('https://x');
});

it('collects a repeated flag into an array, preserving order', () => {
  const p = parseArgs(['creator', 'add', 'doac', '--shorts-url', 'https://a', '--shorts-url', 'https://b']);
  expect(p.flags['shorts-url']).toEqual(['https://a', 'https://b']);
});

it('a third repetition keeps appending to the same array', () => {
  const p = parseArgs(['--shorts-url', 'a', '--shorts-url', 'b', '--shorts-url', 'c']);
  expect(p.flags['shorts-url']).toEqual(['a', 'b', 'c']);
});

it('bare boolean flags still work and can repeat', () => {
  const p = parseArgs(['--live', '--live']);
  expect(p.flags.live).toEqual([true, true]);
});

// Review finding: boolean switches were read with Boolean(flag), so `--live=false` (the string
// "false") meant a LIVE YouTube upload. asBool is strict: bare flag or true/false only.
it('asBool: --live=false and --live false are false, never a live upload', () => {
  expect(asBool(parseArgs(['publish', '--live=false']).flags.live, 'live')).toBe(false);
  expect(asBool(parseArgs(['publish', '--live', 'false']).flags.live, 'live')).toBe(false);
  expect(asBool(parseArgs(['publish', '--live=FALSE']).flags.live, 'live')).toBe(false);
});
it('asBool: a bare flag or =true is true; absent is false', () => {
  expect(asBool(parseArgs(['publish', '--live']).flags.live, 'live')).toBe(true);
  expect(asBool(parseArgs(['publish', '--live=true']).flags.live, 'live')).toBe(true);
  expect(asBool(parseArgs(['publish']).flags.live, 'live')).toBe(false);
});
it('asBool: any other value is an error, not silently true', () => {
  expect(() => asBool(parseArgs(['publish', '--live=0']).flags.live, 'live')).toThrow(/--live/);
  expect(() => asBool(parseArgs(['analyze', '--force', 'src_abc']).flags.force, 'force')).toThrow(/"src_abc"/);
});
it('asBool: repeated flags use the last value, like asString', () => {
  expect(asBool(parseArgs(['--live', '--live=false']).flags.live, 'live')).toBe(false);
});

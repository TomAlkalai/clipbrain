import { it, expect } from 'vitest';
import { parseArgs } from '../src/cli.js';

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

import { it, expect } from 'vitest';
import { foldOf, outOfFold, findLeaks, assertNoLeak } from '../src/bench/folds.js';

it('foldOf is deterministic, in range, and roughly balanced', () => {
  const ids = Array.from({ length: 300 }, (_, i) => `vid${i}`);
  const folds = ids.map((id) => foldOf(id, 3));
  expect(folds).toEqual(ids.map((id) => foldOf(id, 3)));
  expect(folds.every((f) => f >= 0 && f < 3)).toBe(true);
  for (let f = 0; f < 3; f++) expect(folds.filter((x) => x === f).length).toBeGreaterThan(70);
});

it('outOfFold keeps only items whose episode is in another fold', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f'].map((episodeId) => ({ episodeId }));
  const fold = foldOf('a', 3);
  const kept = outOfFold(items, fold, 3);
  expect(kept.every((x) => foldOf(x.episodeId, 3) !== fold)).toBe(true);
  expect(kept.length + items.filter((x) => foldOf(x.episodeId, 3) === fold).length).toBe(items.length);
});

const heldOut = [
  { shortId: 's1', title: 'Your Cash Is NOT Safe Anymore!', text: 'the thing nobody tells you about inflation is that your savings account is quietly losing money every single year' },
  { shortId: 's2', title: 'Wow', text: 'short one' },
];

it('findLeaks spots a held-out Short title or opening line in a prompt, ignoring case and punctuation', () => {
  expect(findLeaks('Audience examples:\n- "your cash is not safe anymore" (perf 1.2)', heldOut)).toEqual([{ shortId: 's1', kind: 'title' }]);
  expect(findLeaks('Hook patterns: (e.g. "The thing nobody tells you about inflation, is that your savings account...")', heldOut))
    .toEqual([{ shortId: 's1', kind: 'opening' }]);
});

it('findLeaks ignores titles and openings too short to be evidence', () => {
  expect(findLeaks('wow this is a short one', heldOut)).toEqual([]);
});

it('assertNoLeak throws naming the leaked Shorts and where', () => {
  expect(() => assertNoLeak('Your cash is not safe anymore', heldOut, 'rank prompt for ep1')).toThrow(/rank prompt for ep1.*s1 \(title\)/);
  expect(() => assertNoLeak('clean prompt', heldOut, 'x')).not.toThrow();
});

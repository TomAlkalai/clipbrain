import type { Word, Alignment, AlignedSegment } from '../types.js';
import { tokenize, type Tok } from '../text/tokens.js';

const K = 5; // shingle length in tokens
const OFFSET_TOLERANCE = 3; // max drift in (episode - short) token-index offset to stay in the same segment/support group
const MAX_GAP = 7; // max short-token-index jump to stay in the same segment

export type EpisodeIndex = {
  eps: { id: string; toks: Tok[]; durationSec: number; words: Word[] }[];
  map: Map<string, { e: number; p: number }[]>;
};

function shingleKey(toks: Tok[], i: number): string {
  return toks
    .slice(i, i + K)
    .map((t) => t.tok)
    .join(' ');
}

// K-token shingle index over a set of episodes. Shingles that recur more than `maxPostings`
// times across the corpus (stock phrases, intros, etc.) are dropped so they cannot dominate voting.
export function buildIndex(
  episodes: { id: string; words: Word[]; durationSec: number }[],
  maxPostings = 25
): EpisodeIndex {
  const eps = episodes.map((ep) => ({
    id: ep.id,
    toks: tokenize(ep.words),
    durationSec: ep.durationSec,
    words: ep.words,
  }));

  const map = new Map<string, { e: number; p: number }[]>();
  eps.forEach((ep, e) => {
    for (let p = 0; p + K <= ep.toks.length; p++) {
      const key = shingleKey(ep.toks, p);
      let postings = map.get(key);
      if (!postings) {
        postings = [];
        map.set(key, postings);
      }
      postings.push({ e, p });
    }
  });

  for (const [key, postings] of map) {
    if (postings.length > maxPostings) map.delete(key);
  }

  return { eps, map };
}

type Hit = { i: number; e: number; p: number };

export function alignShort(
  shortId: string,
  shortWords: Word[],
  idx: EpisodeIndex,
  opts?: { minHits?: number; minCoverage?: number }
): Alignment | null {
  const minHits = opts?.minHits ?? 6;
  const minCoverage = opts?.minCoverage ?? 0.25;
  const shortToks = tokenize(shortWords);

  // 1. Collect hits for every short shingle against the corpus index.
  const hits: Hit[] = [];
  for (let i = 0; i + K <= shortToks.length; i++) {
    const postings = idx.map.get(shingleKey(shortToks, i));
    if (!postings) continue;
    for (const posting of postings) hits.push({ i, e: posting.e, p: posting.p });
  }
  if (hits.length === 0) return null;

  // 2. Vote for the best-matching episode by raw hit count.
  const countByEp = new Map<number, number>();
  for (const h of hits) countByEp.set(h.e, (countByEp.get(h.e) ?? 0) + 1);
  let bestE = -1;
  let bestCount = -1;
  for (const [e, c] of countByEp) {
    if (c > bestCount) {
      bestE = e;
      bestCount = c;
    }
  }
  if (bestE === -1 || bestCount < minHits) return null;

  // 3. For each short position with several candidate postings in the winning episode,
  // keep the one whose (episode - short) offset has the most support from other hits.
  const epHits = hits.filter((h) => h.e === bestE);
  const offsets = epHits.map((h) => h.p - h.i);
  const support = (o: number): number => {
    let n = 0;
    for (const oo of offsets) if (Math.abs(oo - o) <= OFFSET_TOLERANCE) n++;
    return n;
  };

  const byI = new Map<number, Hit[]>();
  for (const h of epHits) {
    const arr = byI.get(h.i);
    if (arr) arr.push(h);
    else byI.set(h.i, [h]);
  }

  const kept: { i: number; p: number; o: number }[] = [];
  for (const [, arr] of byI) {
    let best = arr[0];
    let bestSupport = -1;
    for (const h of arr) {
      const o = h.p - h.i;
      const s = support(o);
      if (s > bestSupport) {
        bestSupport = s;
        best = h;
      }
    }
    kept.push({ i: best.i, p: best.p, o: best.p - best.i });
  }
  kept.sort((a, b) => a.i - b.i);

  // 4. Chain kept hits into contiguous segments.
  const ep = idx.eps[bestE];
  const segments: AlignedSegment[] = [];
  const coveredRanges: [number, number][] = [];
  let chain: typeof kept = [];

  const flush = (): void => {
    if (chain.length >= 2) {
      const i0 = chain[0].i;
      const i1 = chain[chain.length - 1].i;
      const p0 = chain[0].p;
      const p1 = chain[chain.length - 1].p;
      const shortEndIdx = i1 + K - 1;
      const srcEndIdx = p1 + K - 1;
      segments.push({
        shortStart: shortToks[i0].start,
        shortEnd: shortToks[shortEndIdx].end,
        srcStart: ep.toks[p0].start,
        srcEnd: ep.toks[srcEndIdx].end,
        tokens: i1 + K - i0,
      });
      coveredRanges.push([i0, shortEndIdx]);
    }
    chain = [];
  };

  for (const h of kept) {
    if (chain.length === 0) {
      chain.push(h);
      continue;
    }
    const prev = chain[chain.length - 1];
    if (Math.abs(h.o - prev.o) <= OFFSET_TOLERANCE && h.i - prev.i <= MAX_GAP) {
      chain.push(h);
    } else {
      flush();
      chain.push(h);
    }
  }
  flush();

  if (segments.length === 0) return null;

  // 5. Coverage = union of covered short-token indices / short token count.
  const covered = new Set<number>();
  for (const [a, b] of coveredRanges) for (let x = a; x <= b; x++) covered.add(x);
  const coverage = shortToks.length > 0 ? covered.size / shortToks.length : 0;
  if (coverage < minCoverage) return null;

  return { shortId, episodeId: ep.id, segments, coverage, hits: bestCount };
}

import type { Word } from '../types.js';

type RawSeg = { utf8?: string; tOffsetMs?: number };
type RawEvent = { tStartMs: number; dDurationMs?: number; segs?: RawSeg[] };

type PreparedSeg = { text: string; startMs: number };
type PreparedEvent = { tStartMs: number; dDurationMs: number; segs: PreparedSeg[] };

// YouTube's json3 subtitle format: events with (possibly several) segs each carrying
// a tOffsetMs relative to the event's tStartMs. Events/segs with only whitespace are
// skipped entirely (they carry no words and don't count as a timing boundary either).
export function parseJson3(json: any): Word[] {
  const events: RawEvent[] = json?.events ?? [];

  const prepared: PreparedEvent[] = [];
  for (const ev of events) {
    const segs: PreparedSeg[] = (ev.segs ?? [])
      .map((s: RawSeg) => ({ text: (s.utf8 ?? '').trim(), startMs: ev.tStartMs + (s.tOffsetMs ?? 0) }))
      .filter((s: PreparedSeg) => s.text.length > 0);
    if (segs.length === 0) continue;
    prepared.push({ tStartMs: ev.tStartMs, dDurationMs: ev.dDurationMs ?? 0, segs });
  }

  const words: Word[] = [];
  for (let i = 0; i < prepared.length; i++) {
    const ev = prepared[i];
    const nextEventStartMs = i + 1 < prepared.length ? prepared[i + 1].segs[0].startMs : Infinity;
    const eventEndMs = Math.min(nextEventStartMs, ev.tStartMs + ev.dDurationMs);
    for (let s = 0; s < ev.segs.length; s++) {
      const seg = ev.segs[s];
      const segEndMs = s + 1 < ev.segs.length ? ev.segs[s + 1].startMs : eventEndMs;
      const parts = seg.text.split(/\s+/).filter((p) => p.length > 0);
      const span = (segEndMs - seg.startMs) / parts.length;
      for (let j = 0; j < parts.length; j++) {
        const start = seg.startMs + span * j;
        const end = seg.startMs + span * (j + 1);
        words.push({ w: parts[j], start: start / 1000, end: end / 1000 });
      }
    }
  }
  return words;
}

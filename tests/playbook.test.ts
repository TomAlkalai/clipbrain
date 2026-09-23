import { it, expect } from 'vitest';
import { defaultPlaybook, computeStats, renderPlaybookMd, playbookPromptBlock } from '../src/playbook/playbook.js';
const f = (perf: number, dur: number, coldOpen: boolean) => ({ shortId: 'x' + perf, episodeId: 'e', title: 't', views: 1, perf, durationSec: dur, srcSpanSec: dur, nSegments: coldOpen ? 2 : 1, coldOpen, tightened: false, startsAfterPause: true, positionInEpisode: 0.5, text: '', contextBefore: '' });
it('computes stats with a top tercile', () => {
  const s = computeStats([f(-1, 20, false), f(0, 30, false), f(1, 40, true), f(2, 50, true), f(-2, 60, false), f(0.5, 35, false)]);
  expect(s.nAligned).toBe(6); expect(s.duration.median).toBeCloseTo(37.5); expect(s.topColdOpenRate).toBe(1); expect(s.coldOpenRate).toBeCloseTo(2 / 6);
});
it('renders markdown and prompt block', () => {
  const pb = defaultPlaybook('doac');
  expect(renderPlaybookMd(pb)).toContain('## Hook patterns');
  const b = playbookPromptBlock(pb); expect(b).toContain('[contrarian]'); expect(b).toContain('Ideal duration: 20–75 s');
});

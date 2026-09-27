import React from 'react';
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { loadFont } from '@remotion/google-fonts/Montserrat';
import { entryAnimationFrames } from '../src/edit/timing';
import type { EdlCaption } from '../src/types';

// Scoped to exactly the weight/subset actually used (weight 900, latin) instead of the default
// "all weights, all subsets" — that default was measured making 45-90 font network requests per
// browser tab (each of Remotion's parallel render tabs loads fonts independently, so this cost is
// paid once per tab); see fix round 1 in task-12-report.md.
const { fontFamily } = loadFont('normal', { weights: ['900'], subsets: ['latin'], ignoreTooManyRequestsWarning: true });

const PAGE_ENTRY_FRAMES = 6;

export const Captions: React.FC<{ captions: EdlCaption[]; st: { accent: string; captionTop: number } }> = ({
  captions,
  st,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const page = captions.find((c) => t >= c.start && t < c.end);
  if (!page) return null;

  const pageStartFrame = Math.round(page.start * fps);
  const pageEndFrame = Math.round(page.end * fps);
  const scale = spring({
    frame: frame - pageStartFrame,
    fps,
    config: { damping: 200 },
    durationInFrames: entryAnimationFrames(pageEndFrame - pageStartFrame, PAGE_ENTRY_FRAMES),
    from: 0.85,
    to: 1,
  });

  return (
    <AbsoluteFill style={{ top: st.captionTop, alignItems: 'center', justifyContent: 'flex-start' }}>
      <div
        style={{
          transform: `scale(${scale})`,
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          alignItems: 'baseline',
          maxWidth: 960,
          columnGap: 22,
          rowGap: 6,
          padding: '0 24px',
        }}
      >
        {page.words.map((w, idx) => {
          const active = t >= w.start && t < w.end;
          return (
            <span
              key={idx}
              style={{
                fontFamily,
                fontWeight: 900,
                fontSize: 84,
                textTransform: 'uppercase',
                color: active ? st.accent : '#fff',
                WebkitTextStroke: '10px #000',
                paintOrder: 'stroke fill',
                textShadow: '0 6px 14px rgba(0,0,0,0.65)',
              }}
            >
              {w.w}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

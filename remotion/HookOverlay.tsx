import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { loadFont } from '@remotion/google-fonts/Montserrat';

// Scoped to exactly the weight/subset actually used (weight 800, latin) — see Captions.tsx and
// fix round 1 in task-12-report.md.
const { fontFamily } = loadFont('normal', { weights: ['800'], subsets: ['latin'], ignoreTooManyRequestsWarning: true });

const ENTRY_FRAMES = 8;
const FADE_FRAMES = 6;

export const HookOverlay: React.FC<{
  hook: { text: string; start: number; end: number };
  st: { hookTop: number };
}> = ({ hook, st }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  if (t < hook.start || t >= hook.end) return null;

  const startFrame = Math.round(hook.start * fps);
  const endFrame = Math.round(hook.end * fps);

  const scale = spring({
    frame: frame - startFrame,
    fps,
    config: { damping: 200 },
    durationInFrames: ENTRY_FRAMES,
    from: 0.85,
    to: 1,
  });
  const opacity = interpolate(frame, [endFrame - FADE_FRAMES, endFrame], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{ top: st.hookTop, alignItems: 'center', justifyContent: 'flex-start' }}>
      <div
        style={{
          transform: `scale(${scale})`,
          opacity,
          background: '#fff',
          borderRadius: 24,
          padding: '28px 40px',
          maxWidth: 940,
        }}
      >
        <div style={{ fontFamily, fontWeight: 800, fontSize: 70, color: '#000', textAlign: 'center', lineHeight: 1.15 }}>
          {hook.text}
        </div>
      </div>
    </AbsoluteFill>
  );
};

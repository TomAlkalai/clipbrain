import React from 'react';
import { AbsoluteFill, Sequence } from 'remotion';
import type { Edl } from '../src/types';
import { VideoLayer } from './VideoLayer';
import { Captions } from './Captions';
import { HookOverlay } from './HookOverlay';
import { STYLES } from './style';

export const Clip: React.FC<{ edl: Edl }> = ({ edl }) => {
  const st = STYLES[edl.style] ?? STYLES.default;
  let acc = 0;
  // Segments whose frame length rounds to 0 are skipped entirely rather than forced to a minimum
  // 1 frame — a forced minimum would make that frame overlap the next segment's own `from` (both
  // segments' Sequences claiming the same output frame), instead of a clean back-to-back cut.
  const seqs = edl.segments.flatMap((s, i) => {
    const from = Math.round(acc * edl.fps);
    acc += s.srcEnd - s.srcStart;
    const to = Math.round(acc * edl.fps);
    const durationInFrames = to - from;
    if (durationInFrames <= 0) return [];
    return [
      <Sequence key={i} from={from} durationInFrames={durationInFrames}>
        <VideoLayer
          src={edl.videoSrc}
          startFrom={Math.round(s.srcStart * edl.fps)}
          layout={s.layout}
          srcAspect={edl.srcAspect}
          frames={durationInFrames}
        />
      </Sequence>,
    ];
  });
  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {seqs}
      <Captions captions={edl.captions} st={st} />
      {edl.hook && <HookOverlay hook={edl.hook} st={st} />}
    </AbsoluteFill>
  );
};

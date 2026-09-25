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
  const seqs = edl.segments.map((s, i) => {
    const from = Math.round(acc * edl.fps);
    acc += s.srcEnd - s.srcStart;
    const to = Math.round(acc * edl.fps);
    return (
      <Sequence key={i} from={from} durationInFrames={Math.max(1, to - from)}>
        <VideoLayer
          src={edl.videoSrc}
          startFrom={Math.round(s.srcStart * edl.fps)}
          layout={s.layout}
          srcAspect={edl.srcAspect}
          frames={Math.max(1, to - from)}
        />
      </Sequence>
    );
  });
  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {seqs}
      <Captions captions={edl.captions} st={st} />
      {edl.hook && <HookOverlay hook={edl.hook} st={st} />}
    </AbsoluteFill>
  );
};

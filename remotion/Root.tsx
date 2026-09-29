import React from 'react';
import { Composition } from 'remotion';
import { Clip } from './Clip';
import type { Edl } from '../src/types';

// A tiny but valid EDL so Remotion Studio can open the composition with no clip loaded yet.
const defaultEdl: Edl = {
  fps: 30,
  width: 1080,
  height: 1920,
  videoSrc: '',
  srcAspect: 16 / 9,
  segments: [{ srcStart: 0, srcEnd: 1, layout: { kind: 'fit' } }],
  captions: [],
  hook: null,
  durationSec: 1,
  style: 'default',
};

export const Root: React.FC = () => {
  return (
    <Composition
      id="Clip"
      component={Clip}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={30}
      defaultProps={{ edl: defaultEdl }}
      calculateMetadata={({ props }) => ({
        durationInFrames: Math.max(1, Math.round(props.edl.durationSec * 30)),
      })}
    />
  );
};

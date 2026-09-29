import React from 'react';
import { AbsoluteFill, OffthreadVideo } from 'remotion';
import { cropRect } from '../src/edit/crop';
import { segmentVolume } from '../src/edit/timing';
import type { Layout, Rect } from '../src/types';

const Cropped: React.FC<{
  src: string;
  startFrom: number;
  rect: Rect;
  boxW: number;
  boxH: number;
  srcAspect: number;
  muted?: boolean;
  volume?: (f: number) => number;
  style?: React.CSSProperties;
}> = ({ src, startFrom, rect, boxW, boxH, srcAspect, muted, volume, style }) => {
  const dispW = boxW / rect.w;
  const dispH = dispW / srcAspect;
  return (
    <div style={{ position: 'absolute', width: boxW, height: boxH, overflow: 'hidden', ...style }}>
      <OffthreadVideo
        src={src}
        startFrom={startFrom}
        muted={muted}
        volume={volume}
        style={{ position: 'absolute', width: dispW, height: dispH, left: -rect.x * dispW, top: -rect.y * dispH, maxWidth: 'none' }}
      />
    </div>
  );
};

export const VideoLayer: React.FC<{ src: string; startFrom: number; layout: Layout; srcAspect: number; frames: number }> = ({
  src,
  startFrom,
  layout,
  srcAspect,
  frames,
}) => {
  const vol = (f: number) => segmentVolume(f, frames);

  if (layout.kind === 'face')
    return (
      <Cropped
        src={src}
        startFrom={startFrom}
        rect={cropRect(layout, 1080 / 1920, srcAspect)}
        boxW={1080}
        boxH={1920}
        srcAspect={srcAspect}
        volume={vol}
      />
    );

  if (layout.kind === 'split')
    return (
      <AbsoluteFill>
        <Cropped
          src={src}
          startFrom={startFrom}
          rect={cropRect(layout.top, 1080 / 960, srcAspect)}
          boxW={1080}
          boxH={960}
          srcAspect={srcAspect}
          volume={vol}
        />
        <Cropped
          src={src}
          startFrom={startFrom}
          rect={cropRect(layout.bottom, 1080 / 960, srcAspect)}
          boxW={1080}
          boxH={960}
          srcAspect={srcAspect}
          muted
          style={{ top: 960 }}
        />
        <div style={{ position: 'absolute', top: 956, width: 1080, height: 8, background: '#000' }} />
      </AbsoluteFill>
    );

  if (layout.kind === 'stream')
    return (
      <AbsoluteFill>
        <Cropped src={src} startFrom={startFrom} rect={layout.cam} boxW={1080} boxH={768} srcAspect={srcAspect} volume={vol} />
        <Cropped
          src={src}
          startFrom={startFrom}
          rect={layout.main}
          boxW={1080}
          boxH={1152}
          srcAspect={srcAspect}
          muted
          style={{ top: 768 }}
        />
      </AbsoluteFill>
    );

  // fit: blurred cover background + full frame centred
  const fullH = 1080 / srcAspect;
  return (
    <AbsoluteFill>
      <Cropped
        src={src}
        startFrom={startFrom}
        rect={cropRect({ cx: 0.5, cy: 0.5, zoom: 1 }, 1080 / 1920, srcAspect)}
        boxW={1080}
        boxH={1920}
        srcAspect={srcAspect}
        muted
        style={{ filter: 'blur(28px) brightness(0.55)', transform: 'scale(1.1)' }}
      />
      <Cropped
        src={src}
        startFrom={startFrom}
        rect={{ x: 0, y: 0, w: 1, h: 1 }}
        boxW={1080}
        boxH={fullH}
        srcAspect={srcAspect}
        volume={vol}
        style={{ top: (1920 - fullH) / 2 - 160 }}
      />
    </AbsoluteFill>
  );
};

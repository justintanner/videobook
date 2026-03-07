import React from "react";
import { OffthreadVideo, useVideoConfig } from "remotion";

interface BlurFillVideoProps {
  src: string;
  sourceWidth: number;
  sourceHeight: number;
  volume: number;
  audioFadeIn: number;
  audioFadeOut: number;
}

export const BlurFillVideo: React.FC<BlurFillVideoProps> = ({
  src,
  sourceWidth,
  sourceHeight,
  volume,
  audioFadeIn,
  audioFadeOut,
}) => {
  const { width, height, fps, durationInFrames } = useVideoConfig();

  const fadeInFrames = Math.round((audioFadeIn / 1000) * fps);
  const fadeOutFrames = Math.round((audioFadeOut / 1000) * fps);

  const volumeCallback = React.useCallback(
    (frame: number) => {
      const baseVolume = volume / 100;
      if (frame < fadeInFrames) {
        return baseVolume * (frame / fadeInFrames);
      }
      const framesFromEnd = durationInFrames - frame;
      if (framesFromEnd < fadeOutFrames) {
        return baseVolume * (framesFromEnd / fadeOutFrames);
      }
      return baseVolume;
    },
    [volume, fadeInFrames, fadeOutFrames, durationInFrames],
  );

  const sourceAspect = sourceWidth / sourceHeight;
  const targetAspect = width / height;

  let fgWidth: number;
  let fgHeight: number;
  if (sourceAspect > targetAspect) {
    fgWidth = width;
    fgHeight = width / sourceAspect;
  } else {
    fgHeight = height;
    fgWidth = height * sourceAspect;
  }

  return (
    <div style={{ position: "relative", width, height, overflow: "hidden" }}>
      {/* Background: scaled to cover, blurred */}
      <OffthreadVideo
        src={src}
        style={{
          position: "absolute",
          width: "100%",
          height: "100%",
          objectFit: "cover",
          filter: "blur(20px) brightness(0.6)",
          transform: "scale(1.1)",
        }}
        volume={0}
      />
      {/* Foreground: scaled to fit, centered */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width,
          height,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <OffthreadVideo
          src={src}
          style={{
            width: fgWidth,
            height: fgHeight,
          }}
          volume={volumeCallback}
        />
      </div>
    </div>
  );
};

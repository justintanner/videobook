import React from "react";
import { AbsoluteFill } from "remotion";
import type { RenderInputProps } from "./subtitles/types.js";
import { BlurFillVideo } from "./BlurFillVideo.js";
import { SubtitleOverlay } from "./subtitles/SubtitleOverlay.js";
import { OsgOverlay } from "./OsgOverlay.js";

export const RenderComposition: React.FC<RenderInputProps> = ({
  videoSrc,
  sourceWidth,
  sourceHeight,
  subtitlesEnabled,
  chunks,
  style,
  position,
  fontSize,
  textColor,
  highlightColor,
  audioFadeIn,
  audioFadeOut,
  audioVolume,
  osgSrc,
  osgPosition,
  osgSize,
  backgroundMode,
  strokeWidth,
  strokeColor,
  shadowBlur,
  shadowOpacity,
}) => {
  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <BlurFillVideo
        src={videoSrc}
        sourceWidth={sourceWidth}
        sourceHeight={sourceHeight}
        volume={audioVolume}
        audioFadeIn={audioFadeIn}
        audioFadeOut={audioFadeOut}
        backgroundMode={backgroundMode}
      />
      {subtitlesEnabled && chunks.length > 0 && (
        <SubtitleOverlay
          chunks={chunks}
          style={style}
          position={position}
          fontSize={fontSize}
          textColor={textColor}
          highlightColor={highlightColor}
          strokeWidth={strokeWidth}
          strokeColor={strokeColor}
          shadowBlur={shadowBlur}
          shadowOpacity={shadowOpacity}
        />
      )}
      {osgSrc && (
        <OsgOverlay src={osgSrc} position={osgPosition} size={osgSize} />
      )}
    </AbsoluteFill>
  );
};

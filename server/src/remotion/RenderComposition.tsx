import React from "react";
import { AbsoluteFill } from "remotion";
import type { RenderInputProps } from "./subtitles/types.js";
import { BlurFillVideo } from "./BlurFillVideo.js";
import { SubtitleOverlay } from "./subtitles/SubtitleOverlay.js";

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
      />
      {subtitlesEnabled && chunks.length > 0 && (
        <SubtitleOverlay
          chunks={chunks}
          style={style}
          position={position}
          fontSize={fontSize}
          textColor={textColor}
          highlightColor={highlightColor}
        />
      )}
    </AbsoluteFill>
  );
};

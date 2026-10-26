import React from "react";
import { AbsoluteFill } from "remotion";
import type { RenderInputProps } from "./subtitles/types.js";
import { BlurFillVideo } from "./BlurFillVideo.js";
import { SubtitleOverlay } from "./subtitles/SubtitleOverlay.js";
import { OsgOverlay } from "./OsgOverlay.js";
import { KeywordGraphicsOverlay } from "./KeywordGraphicsOverlay.js";
import { CaptionOverlay } from "./captions/CaptionOverlay.js";

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
  osgScale,
  osgOpacity,
  osgStartSeconds,
  osgEndSeconds,
  osgTailSeconds,
  keywordGraphics,
  backgroundMode,
  strokeWidth,
  strokeColor,
  shadowBlur,
  shadowOpacity,
  captionDocument,
  captionRegions,
}) => {
  const alive = style === "alive";
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
      {subtitlesEnabled && alive && captionDocument && (
        <CaptionOverlay document={captionDocument} regions={captionRegions} fontUrls={null} />
      )}
      {subtitlesEnabled && !alive && chunks.length > 0 && (
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
        <OsgOverlay
          src={osgSrc}
          position={osgPosition}
          size={osgSize}
          scale={osgScale}
          opacity={osgOpacity}
          startSeconds={osgStartSeconds}
          endSeconds={osgEndSeconds}
          tailSeconds={osgTailSeconds}
        />
      )}
      {keywordGraphics.length > 0 && (
        <KeywordGraphicsOverlay graphics={keywordGraphics} />
      )}
    </AbsoluteFill>
  );
};

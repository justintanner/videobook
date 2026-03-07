import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate, Easing } from "remotion";
import type { Chunk, FontSizePreset, SubtitlePosition, Orientation } from "./types.js";
import { getCurrentWordIndex, stripPunctuation } from "../util.js";
import { getTikDanceFontSize, getYPosition, POP_DURATION_FRAMES, POP_SCALE_START, POP_SCALE_END } from "../constants.js";

interface TikDanceProps {
  chunks: Chunk[];
  position: SubtitlePosition;
  fontSize: FontSizePreset;
  textColor: string;
}

export const TikDance: React.FC<TikDanceProps> = ({
  chunks,
  position,
  fontSize,
  textColor,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const currentTime = frame / fps;

  const orientation: Orientation = height > width ? "portrait" : "landscape";
  const fontPx = getTikDanceFontSize(fontSize, orientation);
  const yFraction = getYPosition(position, orientation);
  const yCenter = Math.round(height * yFraction);

  const activeChunk = chunks.find(
    (c) => currentTime >= c.start && currentTime <= c.end,
  );
  if (!activeChunk || activeChunk.words.length === 0) return null;

  const wordIdx = getCurrentWordIndex(activeChunk.words, currentTime);
  if (wordIdx < 0) return null;

  const word = activeChunk.words[wordIdx];
  const displayText = stripPunctuation(word.word.trim()).toUpperCase();
  if (!displayText) return null;

  const wordStartFrame = Math.round(word.start * fps);
  const framesSinceWordStart = frame - wordStartFrame;

  const scale = interpolate(
    framesSinceWordStart,
    [0, POP_DURATION_FRAMES],
    [POP_SCALE_START, POP_SCALE_END],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    },
  );

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        paddingTop: yCenter,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          fontFamily: "Arial Black, Arial, Helvetica, sans-serif",
          fontWeight: 900,
          fontSize: fontPx,
          color: textColor,
          WebkitTextStroke: `4px black`,
          paintOrder: "stroke fill",
          textShadow: "2px 2px 4px rgba(0,0,0,0.5)",
          transform: `scale(${scale})`,
          textAlign: "center",
          lineHeight: 1.1,
          userSelect: "none",
        }}
      >
        {displayText}
      </div>
    </div>
  );
};

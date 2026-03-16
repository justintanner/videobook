import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate, Easing } from "remotion";
import type { Chunk, FontSizePreset, SubtitlePosition, Orientation } from "./types.js";
import { getCurrentWordIndex } from "../util.js";
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

  const orientation: Orientation = height > width ? "portrait" : width === height ? "square" : "landscape";
  const fontPx = getTikDanceFontSize(fontSize, orientation);
  const yFraction = getYPosition(position, orientation);

  const activeChunk = chunks.find(
    (c) => currentTime >= c.start && currentTime <= c.end,
  );
  if (!activeChunk || activeChunk.words.length === 0) return null;

  const wordIdx = getCurrentWordIndex(activeChunk.words, currentTime);

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: yFraction <= 0.3 ? "flex-start" : yFraction >= 0.6 ? "flex-end" : "center",
        justifyContent: "center",
        paddingTop: yFraction <= 0.3 ? `${Math.round(height * yFraction)}px` : undefined,
        paddingBottom: yFraction >= 0.6 ? `${Math.round(height * (1 - yFraction))}px` : undefined,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          alignItems: "center",
          gap: `${Math.round(fontPx * 0.25)}px`,
          maxWidth: `${width - 120}px`,
          padding: "0 60px",
        }}
      >
        {activeChunk.words.map((word, i) => {
          const isActive = i === wordIdx;
          const text = word.word.trim();
          if (!text) return null;

          let scale = 1.0;
          if (isActive) {
            const wordStartFrame = Math.round(word.start * fps);
            const framesSinceWordStart = frame - wordStartFrame;
            scale = interpolate(
              framesSinceWordStart,
              [0, POP_DURATION_FRAMES],
              [POP_SCALE_START, POP_SCALE_END],
              {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: Easing.out(Easing.cubic),
              },
            );
          }

          return (
            <span
              key={i}
              style={{
                fontFamily: "Arial Black, Arial, Helvetica, sans-serif",
                fontWeight: 900,
                fontSize: fontPx,
                lineHeight: 1.2,
                color: isActive ? "#FACC15" : textColor,
                WebkitTextStroke: "4px black",
                paintOrder: "stroke fill",
                textShadow: "2px 2px 4px rgba(0,0,0,0.5)",
                whiteSpace: "nowrap",
                transform: `scale(${scale})`,
                display: "inline-block",
                userSelect: "none",
              }}
            >
              {text}
            </span>
          );
        })}
      </div>
    </div>
  );
};

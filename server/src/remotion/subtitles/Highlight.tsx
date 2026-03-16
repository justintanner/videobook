import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import type { Chunk, FontSizePreset, SubtitlePosition, Orientation } from "./types.js";
import { getCurrentWordIndex } from "../util.js";
import { getHighlightFontSize, getYPosition } from "../constants.js";

interface HighlightProps {
  chunks: Chunk[];
  position: SubtitlePosition;
  fontSize: FontSizePreset;
  textColor: string;
  highlightColor: string;
}

export const Highlight: React.FC<HighlightProps> = ({
  chunks,
  position,
  fontSize,
  textColor,
  highlightColor,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const currentTime = frame / fps;

  const orientation: Orientation = height > width ? "portrait" : width === height ? "square" : "landscape";
  const fontPx = getHighlightFontSize(fontSize, orientation);
  const yFraction = getYPosition(position, orientation);

  const activeChunk = chunks.find(
    (c) => currentTime >= c.start && currentTime <= c.end,
  );
  if (!activeChunk || activeChunk.words.length === 0) return null;

  const wordIdx = getCurrentWordIndex(activeChunk.words, currentTime, 0.05);

  const boxPadding = 8;
  const boxRadius = 8;

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
          gap: `${Math.round(fontPx * 0.3)}px`,
          maxWidth: `${width - 80}px`,
          padding: "0 40px",
        }}
      >
        {activeChunk.words.map((word, i) => {
          const isActive = i === wordIdx;
          const text = word.word.trim().toUpperCase();
          if (!text) return null;
          return (
            <span
              key={i}
              style={{
                fontFamily: "'Montserrat', 'Arial Black', Arial, sans-serif",
                fontWeight: 800,
                fontSize: fontPx,
                lineHeight: 1.2,
                color: textColor,
                textShadow: "2px 2px 4px rgba(0,0,0,0.4)",
                whiteSpace: "nowrap",
                padding: `${boxPadding}px`,
                borderRadius: isActive ? boxRadius : 0,
                backgroundColor: isActive ? highlightColor : "transparent",
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

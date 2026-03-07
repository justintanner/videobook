import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import type { Chunk, FontSizePreset, SubtitlePosition, Orientation } from "./types.js";
import { getCurrentWordIndex } from "../util.js";
import { getHighlightFontSize, getYPosition } from "../constants.js";
import { layoutWords } from "./layout.js";

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

  const orientation: Orientation = height > width ? "portrait" : "landscape";
  const fontPx = getHighlightFontSize(fontSize, orientation);
  const yFraction = getYPosition(position, orientation);

  const activeChunk = chunks.find(
    (c) => currentTime >= c.start && currentTime <= c.end,
  );
  if (!activeChunk || activeChunk.words.length === 0) return null;

  const { layouts, totalHeight } = layoutWords(activeChunk.words, width, fontPx);
  const blockY = Math.round(height * yFraction - totalHeight / 2);

  const wordIdx = getCurrentWordIndex(activeChunk.words, currentTime, 0.05);

  const boxPadding = 8;
  const boxRadius = 8;

  return (
    <div
      style={{
        position: "absolute",
        top: blockY,
        left: 0,
        width: "100%",
        height: totalHeight,
        pointerEvents: "none",
      }}
    >
      {layouts.map((layout, i) => {
        const isActive = i === wordIdx;
        return (
          <React.Fragment key={i}>
            {isActive && layout.width > 0 && (
              <div
                style={{
                  position: "absolute",
                  left: layout.x - boxPadding,
                  top: layout.y - boxPadding,
                  width: layout.width + 2 * boxPadding,
                  height: layout.height + 2 * boxPadding,
                  backgroundColor: highlightColor,
                  borderRadius: boxRadius,
                }}
              />
            )}
            <div
              style={{
                position: "absolute",
                left: layout.x,
                top: layout.y,
                fontFamily: "'Montserrat', 'Arial Black', Arial, sans-serif",
                fontWeight: 800,
                fontSize: fontPx,
                color: textColor,
                lineHeight: `${layout.height}px`,
                textShadow: "2px 2px 4px rgba(0,0,0,0.4)",
                userSelect: "none",
                whiteSpace: "nowrap",
              }}
            >
              {layout.text}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
};

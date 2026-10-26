import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate, Easing } from "remotion";
import { loadFont } from "@remotion/google-fonts/Anton";
import type { Chunk, FontSizePreset, SubtitlePosition, Orientation } from "./types.js";
import { getCurrentWordIndex, joinsPreviousWord } from "../util.js";
import { getImpactFontSize, getYPosition, POP_DURATION_FRAMES, POP_SCALE_START, POP_SCALE_END } from "../constants.js";

const { fontFamily } = loadFont();

interface ImpactProps {
  chunks: Chunk[];
  position: SubtitlePosition;
  fontSize: FontSizePreset;
  textColor: string;
  highlightColor: string;
  strokeWidth: number;
  strokeColor: string;
  shadowBlur: number;
  shadowOpacity: number;
}

export const Impact: React.FC<ImpactProps> = ({
  chunks,
  position,
  fontSize,
  textColor,
  highlightColor,
  strokeWidth,
  strokeColor,
  shadowBlur,
  shadowOpacity,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const currentTime = frame / fps;

  const orientation: Orientation = height > width ? "portrait" : width === height ? "square" : "landscape";
  const fontPx = getImpactFontSize(fontSize, orientation);
  const yFraction = getYPosition(position, orientation);

  const activeChunk = chunks.find(
    (c) => currentTime >= c.start && currentTime <= c.end,
  );
  if (!activeChunk || activeChunk.words.length === 0) return null;

  const wordIdx = getCurrentWordIndex(activeChunk.words, currentTime);
  const gapPx = Math.round(fontPx * 0.25);

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
          justifyContent: "center",
          alignItems: "center",
          gap: `${gapPx}px`,
          maxWidth: `${width - 80}px`,
          padding: "0 40px",
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
                fontFamily,
                fontWeight: 400,
                fontSize: fontPx,
                lineHeight: 1.1,
                color: isActive ? highlightColor : textColor,
                WebkitTextStroke: strokeWidth > 0 ? `${strokeWidth}px ${strokeColor}` : undefined,
                paintOrder: strokeWidth > 0 ? "stroke fill" : undefined,
                textShadow: shadowBlur > 0 ? `${Math.round(shadowBlur / 2)}px ${Math.round(shadowBlur / 2)}px ${shadowBlur}px rgba(0,0,0,${shadowOpacity / 100})` : undefined,
                whiteSpace: "nowrap",
                transform: `scale(${scale})`,
                display: "inline-block",
                marginLeft: joinsPreviousWord(activeChunk.words, i) ? -gapPx : 0,
                userSelect: "none",
              }}
            >
              {text.toUpperCase()}
            </span>
          );
        })}
      </div>
    </div>
  );
};

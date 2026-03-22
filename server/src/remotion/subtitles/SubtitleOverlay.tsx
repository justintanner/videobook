import React from "react";
import type { Chunk, SubtitleStyle, SubtitlePosition, FontSizePreset } from "./types.js";
import { Impact } from "./Impact.js";
import { Highlight } from "./Highlight.js";

interface SubtitleOverlayProps {
  chunks: Chunk[];
  style: SubtitleStyle;
  position: SubtitlePosition;
  fontSize: FontSizePreset;
  textColor: string;
  highlightColor: string;
  strokeWidth: number;
  strokeColor: string;
  shadowBlur: number;
  shadowOpacity: number;
}

export const SubtitleOverlay: React.FC<SubtitleOverlayProps> = ({
  chunks,
  style,
  position,
  fontSize,
  textColor,
  highlightColor,
  strokeWidth,
  strokeColor,
  shadowBlur,
  shadowOpacity,
}) => {
  if (style === "highlight") {
    return (
      <Highlight
        chunks={chunks}
        position={position}
        fontSize={fontSize}
        textColor={textColor}
        highlightColor={highlightColor}
        strokeWidth={strokeWidth}
        strokeColor={strokeColor}
        shadowBlur={shadowBlur}
        shadowOpacity={shadowOpacity}
      />
    );
  }

  return (
    <Impact
      chunks={chunks}
      position={position}
      fontSize={fontSize}
      textColor={textColor}
      highlightColor={highlightColor}
      strokeWidth={strokeWidth}
      strokeColor={strokeColor}
      shadowBlur={shadowBlur}
      shadowOpacity={shadowOpacity}
    />
  );
};

import React from "react";
import type { Chunk, SubtitleStyle, SubtitlePosition, FontSizePreset } from "./types.js";
import { TikDance } from "./TikDance.js";
import { Highlight } from "./Highlight.js";

interface SubtitleOverlayProps {
  chunks: Chunk[];
  style: SubtitleStyle;
  position: SubtitlePosition;
  fontSize: FontSizePreset;
  textColor: string;
  highlightColor: string;
}

export const SubtitleOverlay: React.FC<SubtitleOverlayProps> = ({
  chunks,
  style,
  position,
  fontSize,
  textColor,
  highlightColor,
}) => {
  if (style === "highlight") {
    return (
      <Highlight
        chunks={chunks}
        position={position}
        fontSize={fontSize}
        textColor={textColor}
        highlightColor={highlightColor}
      />
    );
  }

  return (
    <TikDance
      chunks={chunks}
      position={position}
      fontSize={fontSize}
      textColor={textColor}
      highlightColor={highlightColor}
    />
  );
};

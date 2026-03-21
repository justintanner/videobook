import React from "react";
import { Img, useVideoConfig } from "remotion";
import type { OsgPosition } from "./subtitles/types.js";

interface OsgOverlayProps {
  src: string;
  position: OsgPosition;
}

export const OsgOverlay: React.FC<OsgOverlayProps> = ({ src, position }) => {
  const { width } = useVideoConfig();
  const maxSize = Math.round(width * 0.05);
  const padding = Math.round(width * 0.02);

  const posStyle: React.CSSProperties = {
    position: "absolute",
  };
  if (position.startsWith("top")) posStyle.top = padding;
  if (position.startsWith("bottom")) posStyle.bottom = padding;
  if (position.endsWith("left")) posStyle.left = padding;
  if (position.endsWith("right")) posStyle.right = padding;

  return (
    <Img
      src={src}
      style={{
        ...posStyle,
        maxWidth: maxSize,
        maxHeight: maxSize,
        objectFit: "contain",
      }}
    />
  );
};

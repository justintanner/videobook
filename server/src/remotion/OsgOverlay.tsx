import React from "react";
import { Img, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { OsgPosition, OsgSize } from "./subtitles/types.js";

interface OsgOverlayProps {
  src: string;
  position: OsgPosition;
  size: OsgSize;
}

// Max edge of the graphic as a fraction of the video width. `medium` keeps the
// historical 5%; `small` is half that (the "half size" preset), `large` 1.5×.
const SIZE_FACTOR: Record<OsgSize, number> = {
  small: 0.025,
  medium: 0.05,
  large: 0.075,
};

// The OSG always eases in over this window so it never pops in abruptly.
const FADE_IN_SECONDS = 0.4;

export const OsgOverlay: React.FC<OsgOverlayProps> = ({ src, position, size }) => {
  const { width, fps } = useVideoConfig();
  const frame = useCurrentFrame();
  const maxSize = Math.round(width * SIZE_FACTOR[size]);
  const padding = Math.round(width * 0.02);

  const opacity = interpolate(
    frame,
    [0, Math.max(1, Math.round(FADE_IN_SECONDS * fps))],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

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
        opacity,
        maxWidth: maxSize,
        maxHeight: maxSize,
        objectFit: "contain",
      }}
    />
  );
};

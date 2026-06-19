import React from "react";
import { Img, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { OsgPosition, OsgSize } from "./subtitles/types.js";

interface OsgOverlayProps {
  src: string;
  position: OsgPosition;
  size: OsgSize;
  // Multiplier applied on top of the size preset. 1 = preset size. Used by the
  // watermark producer to carry its numeric scale; normal OSG leaves it at 1.
  scale?: number;
  // When set, the graphic only shows during the last `tailSeconds` of the
  // video (a brief end-card, e.g. the QR watermark). null/undefined ⇒ the
  // graphic shows for the full duration (default OSG behavior).
  tailSeconds?: number | null;
}

// Max edge of the graphic as a fraction of the video width. Sized for a
// visible on-screen graphic (TV-style logo bug): `medium` ≈ 14% of width,
// `small` half that, `large` 1.5×. The previous 5%/2.5%/7.5% presets rendered
// a near-invisible corner thumbnail that users read as "OSG didn't apply".
const SIZE_FACTOR: Record<OsgSize, number> = {
  small: 0.07,
  medium: 0.14,
  large: 0.21,
};

// The OSG always eases in over this window so it never pops in abruptly.
const FADE_IN_SECONDS = 0.4;

export const OsgOverlay: React.FC<OsgOverlayProps> = ({
  src,
  position,
  size,
  scale = 1,
  tailSeconds = null,
}) => {
  const { width, fps, durationInFrames } = useVideoConfig();
  const frame = useCurrentFrame();
  const maxSize = Math.round(width * SIZE_FACTOR[size] * scale);
  const padding = Math.round(width * 0.02);

  // When a tail window is set, the graphic appears `tailSeconds` before the end
  // and fades in from there; otherwise it fades in from the first frame.
  const fadeInFrames = Math.max(1, Math.round(FADE_IN_SECONDS * fps));
  const startFrame =
    tailSeconds != null
      ? Math.max(0, durationInFrames - Math.round(tailSeconds * fps))
      : 0;
  const opacity = interpolate(
    frame,
    [startFrame, startFrame + fadeInFrames],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  const [vertical, horizontal] = position.split("-");
  const posStyle: React.CSSProperties = { position: "absolute" };
  const transforms: string[] = [];
  if (vertical === "top") posStyle.top = padding;
  else if (vertical === "bottom") posStyle.bottom = padding;
  else {
    posStyle.top = "50%";
    transforms.push("translateY(-50%)");
  }
  if (horizontal === "left") posStyle.left = padding;
  else if (horizontal === "right") posStyle.right = padding;
  else {
    posStyle.left = "50%";
    transforms.push("translateX(-50%)");
  }
  if (transforms.length > 0) posStyle.transform = transforms.join(" ");

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

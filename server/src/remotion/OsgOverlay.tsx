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
  // Absolute visibility window in seconds (interactive /osg control). The graphic
  // shows only between `startSeconds` and `endSeconds`; null ⇒ open on that side
  // (start of clip / end of clip). When either is set it wins over `tailSeconds`.
  startSeconds?: number | null;
  endSeconds?: number | null;
  // Legacy duration-relative window: the graphic only shows during the last
  // `tailSeconds` of the video (a brief end-card, e.g. the QR watermark). Used as
  // a fallback when no absolute window is set. null/undefined ⇒ full duration.
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

// The OSG always eases in/out over this window so it never pops abruptly.
const FADE_SECONDS = 0.4;

export const OsgOverlay: React.FC<OsgOverlayProps> = ({
  src,
  position,
  size,
  scale = 1,
  startSeconds = null,
  endSeconds = null,
  tailSeconds = null,
}) => {
  const { width, fps, durationInFrames } = useVideoConfig();
  const frame = useCurrentFrame();
  const maxSize = Math.round(width * SIZE_FACTOR[size] * scale);
  const padding = Math.round(width * 0.02);

  // Resolve the visibility window [startFrame, endFrame]. Precedence: an explicit
  // absolute window (startSeconds/endSeconds) wins; else a duration-relative tail;
  // else the full clip. An explicit end < duration gets a symmetric fade-out.
  const hasWindow = startSeconds != null || endSeconds != null;
  let startFrame: number;
  let endFrame: number;
  if (hasWindow) {
    startFrame = startSeconds != null ? Math.round(startSeconds * fps) : 0;
    endFrame = endSeconds != null ? Math.round(endSeconds * fps) : durationInFrames;
  } else if (tailSeconds != null) {
    startFrame = Math.max(0, durationInFrames - Math.round(tailSeconds * fps));
    endFrame = durationInFrames;
  } else {
    startFrame = 0;
    endFrame = durationInFrames;
  }
  startFrame = Math.min(Math.max(0, startFrame), durationInFrames);
  endFrame = Math.min(Math.max(startFrame, endFrame), durationInFrames);
  const hasExplicitEnd = endFrame < durationInFrames;

  // Fades ease over FADE_SECONDS, shrinking to fit very short windows.
  const span = Math.max(1, endFrame - startFrame);
  const maxFade = Math.max(1, Math.round(FADE_SECONDS * fps));
  const fadeIn = Math.max(1, Math.min(maxFade, Math.floor(span / 2)));
  const fadeOut = hasExplicitEnd ? Math.max(1, Math.min(maxFade, Math.floor(span / 2))) : 0;

  const inEnd = startFrame + fadeIn;
  const outStart = endFrame - fadeOut;
  const opacity =
    fadeOut > 0 && outStart > inEnd
      ? interpolate(
          frame,
          [startFrame, inEnd, outStart, endFrame],
          [0, 1, 1, 0],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
        )
      : interpolate(
          frame,
          [startFrame, inEnd],
          [0, 1],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
        );

  // Hard-gate visibility to the window so a collapsed fade (sub-second span)
  // can't leave the graphic showing past an explicit end.
  const inWindow = frame >= startFrame && (!hasExplicitEnd || frame < endFrame);
  const finalOpacity = inWindow ? opacity : 0;

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
        opacity: finalOpacity,
        maxWidth: maxSize,
        maxHeight: maxSize,
        objectFit: "contain",
      }}
    />
  );
};

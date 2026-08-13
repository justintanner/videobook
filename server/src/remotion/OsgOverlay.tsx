import React from "react";
import { Img, useCurrentFrame, useVideoConfig } from "remotion";
import type { OsgPosition, OsgSize } from "./subtitles/types.js";
import {
  osgAnchorPlacement,
  osgFadeEnvelope,
  osgMaxSize,
  osgPadding,
  resolveOsgWindow,
} from "./osg-spec.js";

interface OsgOverlayProps {
  src: string;
  position: OsgPosition;
  size: OsgSize;
  // Multiplier applied on top of the size preset. 1 = preset size. Used by the
  // watermark producer to carry its numeric scale; normal OSG leaves it at 1.
  scale?: number;
  // Base opacity multiplied into the fade envelope. 1 = fully opaque (normal
  // OSG); the floating watermark uses ~0.5 so it stays faint.
  opacity?: number;
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

export const OsgOverlay: React.FC<OsgOverlayProps> = ({
  src,
  position,
  size,
  scale = 1,
  opacity = 1,
  startSeconds = null,
  endSeconds = null,
  tailSeconds = null,
}) => {
  const { width, fps, durationInFrames } = useVideoConfig();
  const frame = useCurrentFrame();
  const maxSize = osgMaxSize(width, size, scale);
  const padding = osgPadding(width);

  const window = resolveOsgWindow({ startSeconds, endSeconds, tailSeconds, durationInFrames, fps });
  const finalOpacity = osgFadeEnvelope(frame, window, fps) * opacity;

  const placement = osgAnchorPlacement(position, padding);
  const posStyle: React.CSSProperties = { position: "absolute" };
  if (placement.top !== undefined) posStyle.top = placement.top;
  if (placement.bottom !== undefined) posStyle.bottom = placement.bottom;
  if (placement.left !== undefined) posStyle.left = placement.left;
  if (placement.right !== undefined) posStyle.right = placement.right;
  if (placement.transforms.length > 0) posStyle.transform = placement.transforms.join(" ");

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

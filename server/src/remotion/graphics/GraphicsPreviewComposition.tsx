import React, { useMemo } from "react";
import { AbsoluteFill, OffthreadVideo, useCurrentFrame, useVideoConfig } from "remotion";
import type { GraphicsLayerLayout } from "../../graphics/layout.js";
import type { GraphicsDocument } from "../../graphics/model.js";
import type { CaptionFontUrls } from "../captions/caption-fonts.js";
import type { GraphicsOverlayImage } from "./GraphicsOverlay.js";
import { GraphicsOverlay } from "./GraphicsOverlay.js";

export interface GraphicsPreviewProps extends Record<string, unknown> {
  videoSrc: string;
  width: number;
  height: number;
  durationSeconds: number;
  document: GraphicsDocument;
  images: Readonly<Record<string, GraphicsOverlayImage>>;
  fontUrls: CaptionFontUrls;
  onLayout?: (layout: GraphicsLayerLayout[]) => void;
}

export const GraphicsPreviewComposition: React.FC<GraphicsPreviewProps> = ({ videoSrc, width, height, durationSeconds, document, images, fontUrls, onLayout }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const size = useMemo(() => ({ width, height }), [width, height]);
  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <OffthreadVideo src={videoSrc} style={{ width: "100%", height: "100%", objectFit: "fill" }} />
      <GraphicsOverlay
        document={document}
        frame={size}
        durationSeconds={durationSeconds}
        images={images}
        fontUrls={fontUrls}
        onLayout={onLayout}
        seconds={frame / fps}
      />
    </AbsoluteFill>
  );
};

import { graphicsVideoTransform, ORIGINAL_GRAPHICS_FRAME, type GraphicsFraming } from "../../graphics/frame.js";
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
  sourceWidth?: number;
  sourceHeight?: number;
  framing?: GraphicsFraming;
  background?: "blur" | "black";
  document: GraphicsDocument;
  images: Readonly<Record<string, GraphicsOverlayImage>>;
  fontUrls: CaptionFontUrls;
  onLayout?: (layout: GraphicsLayerLayout[]) => void;
}

export const GraphicsPreviewComposition: React.FC<GraphicsPreviewProps> = ({ videoSrc, width, height, durationSeconds, document, images, fontUrls, onLayout, sourceWidth = width, sourceHeight = height, framing = ORIGINAL_GRAPHICS_FRAME, background = "blur" }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const size = useMemo(() => ({ width, height }), [width, height]);
  const source = { width: sourceWidth, height: sourceHeight };
  const foreground = graphicsVideoTransform(source, size, framing.fit, framing.focus);
  const backdrop = graphicsVideoTransform(source, size, "crop", ORIGINAL_GRAPHICS_FRAME.focus, 1.1);
  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {framing.aspect !== "original" && framing.fit === "blur" && background === "blur" && <OffthreadVideo src={videoSrc} volume={0} style={{ position: "absolute", maxWidth: "none", maxHeight: "none", ...backdrop, filter: "blur(20px) brightness(0.6)" }} />}
      <OffthreadVideo src={videoSrc} style={{ position: "absolute", maxWidth: "none", maxHeight: "none", ...foreground }} />
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

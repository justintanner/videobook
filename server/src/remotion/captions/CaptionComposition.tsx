import React, { useMemo } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { CaptionRegionFrame } from "../../captions/layout.js";
import type { CaptionDocument } from "../../captions/model.js";
import type { GraphicsDocument } from "../../graphics/model.js";
import { GraphicsOverlay, type GraphicsOverlayImage } from "../graphics/GraphicsOverlay.js";
import { BlurFillVideo } from "../BlurFillVideo.js";
import type { CaptionFontUrls } from "./caption-fonts.js";
import { CaptionOverlay } from "./CaptionOverlay.js";

export interface CaptionCompositionProps extends Record<string, unknown> {
  graphics?: { document: GraphicsDocument; durationSeconds: number; images: Record<string, GraphicsOverlayImage> } | null;
  videoSrc: string;
  sourceWidth: number;
  sourceHeight: number;
  durationInFrames: number;
  fps: number;
  document: CaptionDocument;
  regions: CaptionRegionFrame[];
  fontUrls: CaptionFontUrls;
}

export const CaptionComposition: React.FC<CaptionCompositionProps> = ({ videoSrc, sourceWidth, sourceHeight, document, regions, fontUrls, graphics }) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const graphicsFrame = useMemo(() => ({ width, height }), [width, height]);
  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <BlurFillVideo
        src={videoSrc}
        sourceWidth={sourceWidth}
        sourceHeight={sourceHeight}
        volume={100}
        audioFadeIn={0}
        audioFadeOut={0}
        backgroundMode={document.style.background}
      />
      {graphics && <GraphicsOverlay document={graphics.document} frame={graphicsFrame} durationSeconds={graphics.durationSeconds} images={graphics.images} fontUrls={fontUrls} seconds={frame / fps} />}
      <CaptionOverlay document={document} regions={regions} fontUrls={fontUrls} />
    </AbsoluteFill>
  );
};

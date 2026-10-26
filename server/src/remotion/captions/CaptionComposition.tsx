import React from "react";
import { AbsoluteFill } from "remotion";
import type { CaptionRegionFrame } from "../../captions/layout.js";
import type { CaptionDocument } from "../../captions/model.js";
import { BlurFillVideo } from "../BlurFillVideo.js";
import type { CaptionFontUrls } from "./caption-fonts.js";
import { CaptionOverlay } from "./CaptionOverlay.js";

export interface CaptionCompositionProps extends Record<string, unknown> {
  videoSrc: string;
  sourceWidth: number;
  sourceHeight: number;
  durationInFrames: number;
  fps: number;
  document: CaptionDocument;
  regions: CaptionRegionFrame[];
  fontUrls: CaptionFontUrls;
}

export const CaptionComposition: React.FC<CaptionCompositionProps> = ({ videoSrc, sourceWidth, sourceHeight, document, regions, fontUrls }) => (
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
    <CaptionOverlay document={document} regions={regions} fontUrls={fontUrls} />
  </AbsoluteFill>
);

import React from "react";
import { Composition, registerRoot } from "remotion";
import { RenderComposition } from "./RenderComposition.js";
import { QrOutroComposition } from "./QrOutroComposition.js";
import { buildOutroSpec } from "./qr-outro-spec.js";
import type { QrOutroInputProps } from "./QrOutroComposition.js";
import type { RenderInputProps } from "./subtitles/types.js";
import { CaptionComposition } from "./captions/CaptionComposition.js";
import { captionCompositionSize } from "./captions/composition-meta.js";
import type { CaptionCompositionProps } from "./captions/CaptionComposition.js";
import { CAPTION_DOCUMENT_VERSION, DEFAULT_CAPTION_STYLE } from "../captions/model.js";

const defaultProps: RenderInputProps = {
  videoSrc: "",
  targetWidth: 1920,
  targetHeight: 1080,
  sourceWidth: 1920,
  sourceHeight: 1080,
  durationInFrames: 300,
  fps: 30,
  subtitlesEnabled: false,
  chunks: [],
  style: "impact",
  position: "bottom",
  fontSize: "medium",
  textColor: "#F8FAFC",
  highlightColor: "#991B1B",
  audioFadeIn: 0,
  audioFadeOut: 0,
  audioVolume: 100,
  osgSrc: null,
  osgPosition: "top-right",
  osgSize: "medium",
  osgScale: 1,
  osgOpacity: 1,
  osgStartSeconds: null,
  osgEndSeconds: null,
  osgTailSeconds: null,
  keywordGraphics: [],
  backgroundMode: "blur",
  strokeWidth: 6,
  strokeColor: "#000000",
  shadowBlur: 6,
  shadowOpacity: 60,
  captionDocument: null,
  captionRegions: [],
};

const defaultCaptionProps: CaptionCompositionProps = {
  videoSrc: "",
  sourceWidth: 1080,
  sourceHeight: 1920,
  durationInFrames: 30,
  fps: 30,
  regions: [],
  fontUrls: null,
  document: {
    version: CAPTION_DOCUMENT_VERSION,
    language: "original",
    sourceLanguage: null,
    wordTiming: "measured",
    source: { artifactId: "preview", mediaHash: "preview", durationSeconds: 1, width: 1080, height: 1920, fps: 30 },
    bindings: { transcriptKey: "preview", vocalKey: null, translationKey: null },
    aspect: "9:16",
    positions: {},
    style: DEFAULT_CAPTION_STYLE,
    words: [],
    phrases: [],
    nextId: 1,
  },
};

const defaultQrOutroProps: QrOutroInputProps = {
  qrSrcs: [""],
  audioSrc: null,
  aspectRatio: "16:9",
  durationSeconds: null,
  includeAudio: true,
};

// eslint-disable-next-line react-refresh/only-export-components
const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="render"
        component={RenderComposition as React.FC<Record<string, unknown>>}
        durationInFrames={defaultProps.durationInFrames}
        fps={defaultProps.fps}
        width={defaultProps.targetWidth}
        height={defaultProps.targetHeight}
        defaultProps={defaultProps}
        calculateMetadata={({ props }) => ({
          durationInFrames: (props as RenderInputProps).durationInFrames,
          fps: (props as RenderInputProps).fps,
          width: (props as RenderInputProps).targetWidth,
          height: (props as RenderInputProps).targetHeight,
        })}
      />
      <Composition
        id="captions"
        component={CaptionComposition as React.FC<Record<string, unknown>>}
        durationInFrames={defaultCaptionProps.durationInFrames}
        fps={defaultCaptionProps.fps}
        width={1080}
        height={1920}
        defaultProps={defaultCaptionProps}
        calculateMetadata={({ props }) => {
          const input = props as CaptionCompositionProps;
          const size = captionCompositionSize(input.document);
          return { durationInFrames: input.durationInFrames, fps: input.fps, width: size.width, height: size.height };
        }}
      />
      <Composition
        id="qr-outro"
        component={QrOutroComposition as React.FC<Record<string, unknown>>}
        durationInFrames={90}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={defaultQrOutroProps}
        calculateMetadata={({ props }) => {
          const input = props as QrOutroInputProps;
          const spec = buildOutroSpec(
            input.aspectRatio,
            input.qrSrcs.length,
            input.durationSeconds ?? undefined,
          );
          return {
            durationInFrames: spec.totalDurationFrames,
            fps: spec.fps,
            width: spec.layout.width,
            height: spec.layout.height,
          };
        }}
      />
    </>
  );
};

registerRoot(RemotionRoot);

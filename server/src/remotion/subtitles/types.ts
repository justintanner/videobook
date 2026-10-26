export interface Word {
  word: string;
  start: number;
  end: number;
}

export interface Segment {
  start: number;
  end: number;
  text: string;
  words: Word[];
}

export interface Chunk {
  start: number;
  end: number;
  text: string;
  words: Word[];
}

export type Orientation = "landscape" | "portrait" | "square";
export type SubtitleStyle = "impact" | "highlight" | "alive";
export type SubtitlePosition = "top" | "middle" | "bottom";
export type FontSizePreset = "small" | "medium" | "large";
export type OsgPosition =
  | "top-left" | "top-center" | "top-right"
  | "middle-left" | "middle-center" | "middle-right"
  | "bottom-left" | "bottom-center" | "bottom-right";
export type OsgSize = "small" | "medium" | "large";
export type BackgroundMode = "blur" | "black";
export type KeywordGraphicAnchor =
  | "upper-left"
  | "upper-right"
  | "middle-left"
  | "middle-right";

export interface KeywordGraphic {
  text: string;
  start: number;
  end: number;
  side: "left" | "right";
  frameTime?: number;
  anchor?: KeywordGraphicAnchor;
  scale?: number;
}



import type { CaptionRegionFrame } from "../../captions/layout.js";
import type { CaptionDocument } from "../../captions/model.js";

export interface RenderInputProps extends Record<string, unknown> {
  videoSrc: string;
  targetWidth: number;
  targetHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  durationInFrames: number;
  fps: number;
  subtitlesEnabled: boolean;
  chunks: Chunk[];
  style: SubtitleStyle;
  position: SubtitlePosition;
  fontSize: FontSizePreset;
  textColor: string;
  highlightColor: string;
  audioFadeIn: number;
  audioFadeOut: number;
  audioVolume: number;
  osgSrc: string | null;
  osgPosition: OsgPosition;
  osgSize: OsgSize;
  osgScale: number;
  osgOpacity: number;
  osgStartSeconds: number | null;
  osgEndSeconds: number | null;
  osgTailSeconds: number | null;
  keywordGraphics: KeywordGraphic[];
  backgroundMode: BackgroundMode;
  strokeWidth: number;
  strokeColor: string;
  shadowBlur: number;
  shadowOpacity: number;
  captionDocument: CaptionDocument | null;
  captionRegions: CaptionRegionFrame[];
}

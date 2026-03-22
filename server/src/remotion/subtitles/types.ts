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
export type SubtitleStyle = "impact" | "highlight";
export type SubtitlePosition = "top" | "middle" | "bottom";
export type FontSizePreset = "small" | "medium" | "large";
export type OsgPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type BackgroundMode = "blur" | "black";

export interface RenderSettings {
  subtitlesEnabled: boolean;
  highlightStyle: SubtitleStyle;
  position: SubtitlePosition;
  fontSize: FontSizePreset;
  textColor: string;
  highlightColor: string;
  audioFadeIn: number;
  audioFadeOut: number;
  audioVolume: number;
  backgroundMode: BackgroundMode;
}

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
  backgroundMode: BackgroundMode;
  strokeWidth: number;
  strokeColor: string;
  shadowBlur: number;
  shadowOpacity: number;
}

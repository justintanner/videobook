/**
 * Alive captions: stacked, frame-aware, audio-timed music-video subtitles.
 * These types are shared by the server (analysis, render) and the client
 * studio preview, so this file must stay free of runtime imports.
 */

export type AliveStyle = "stack" | "punch" | "karaoke";
export type AliveMotion = "pop" | "slam" | "rise";
export type AliveRegionKind = "face" | "text" | "graphic";
export type AliveColumnSide = "left" | "right" | "center";

export interface AliveSettings {
  style: AliveStyle;
  motion: AliveMotion;
  /** Size lines and punch words by the vocal energy measured under each word. */
  energySizing: boolean;
  /** Start words on detected vocal onsets instead of raw transcript times. */
  snapToOnsets: boolean;
  avoidFaces: boolean;
  avoidText: boolean;
  textColor: string;
  hitColor: string;
}

export const ALIVE_STYLES: readonly AliveStyle[] = ["stack", "punch", "karaoke"];
export const ALIVE_MOTIONS: readonly AliveMotion[] = ["pop", "slam", "rise"];

export const DEFAULT_ALIVE_SETTINGS: AliveSettings = {
  style: "stack",
  motion: "pop",
  energySizing: true,
  snapToOnsets: true,
  avoidFaces: true,
  avoidText: true,
  textColor: "#F8FAFC",
  hitColor: "#72E7AA",
};

export interface NormalizedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An occupied area of the SOURCE frame, normalized 0..1. */
export interface AliveRegion extends NormalizedBox {
  kind: AliveRegionKind;
  confidence: number;
}

export interface AliveWord {
  text: string;
  transcriptStart: number;
  transcriptEnd: number;
  /** Nearest detected vocal onset; equals transcriptStart when none was close. */
  onsetStart: number;
  /** Vocal energy under the word, 0..1 relative to the loudest words. */
  energy: number;
}

export interface AlivePhrase {
  id: string;
  /** Source time of the frame analysed for occupied regions. */
  frameTime: number;
  regions: AliveRegion[];
  lines: AliveWord[][];
}

export interface AliveAnalysis {
  version: number;
  fingerprint: string;
  analyzedAt: string;
  durationSeconds: number;
  sourceWidth: number;
  sourceHeight: number;
  /** Samples per second of `envelope`. */
  envelopeHz: number;
  /** Vocal-band loudness, 0..1. */
  envelope: number[];
  onsets: number[];
  regionsAnalyzed: boolean;
  phrases: AlivePhrase[];
}

export interface AliveTimedWord {
  text: string;
  start: number;
  end: number;
  energy: number;
}

/** Target-frame pixel box a phrase stacks into. */
export interface AliveColumn {
  side: AliveColumnSide;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AliveCueLine {
  words: AliveTimedWord[];
  fontSize: number;
}

export interface AliveCue {
  id: string;
  start: number;
  end: number;
  column: AliveColumn;
  /** Stack layout; punch sizes its single word per frame instead. */
  lines: AliveCueLine[];
  blockTop: number;
}

export interface FrameGeometry {
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
}

export type TrimMode = 'keep' | 'remove' | 'split';

export interface TrimRange {
  startPct: number;
  endPct: number;
}

export interface SnapMarker {
  timeSec: number;
  label: string;
}

export interface TranscriptWord {
  text: string;
  start: number;
  end: number;
}

export interface FrameBadge {
  percent: number;
  src: string;
  time: string;
}

export interface TimeMark {
  timeSec: number;
  label: string;
}

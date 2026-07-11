export interface SceneMarker {
  timeSec: number;
  label: string;
}

export interface TimeMark {
  timeSec: number;
  label: string;
}

export interface SplitTarget {
  assetId: string;
  atSec?: number;
}

export interface TimedCue {
  text: string;
  start: number;
  end: number;
  speakerId?: string;
}

export type TranscriptState =
  | { status: 'loading' }
  | { status: 'timed'; languageCode: string | null; cues: TimedCue[]; text: string }
  | { status: 'plain'; text: string }
  | { status: 'silence' }
  | { status: 'missing' }
  | { status: 'error'; message: string };

export const RHYTHM_ANALYZER_ID = "videobook-spectral-flux-dp";
export const RHYTHM_ANALYZER_VERSION = "4";
export const RHYTHM_SCHEMA_VERSION = 1;
export const RHYTHM_SAMPLE_RATE = 22_050;
export const RHYTHM_WINDOW_SAMPLES = 1_024;
export const RHYTHM_HOP_SAMPLES = 256;
export const RHYTHM_LATENCY_SAMPLES = RHYTHM_WINDOW_SAMPLES / 2;

export const RHYTHM_MAX_RETAINED_SAMPLES = RHYTHM_WINDOW_SAMPLES + RHYTHM_HOP_SAMPLES;

export type RhythmTempoAmbiguity = "half" | "double" | "stable";

export interface RhythmBeat {
  timeSeconds: number;
  confidence: number | null;
}

export interface RhythmOnset {
  timeSeconds: number;
  strength: number;
}

export interface RhythmBar {
  timeSeconds: number;
  confidence: number | null;
}

export interface RhythmMeter {
  beatsPerBar: number;
  confidence: number;
}

export interface RhythmResources {
  peakRssBytes: number;
  maxEventLoopLagMs: number;
  pcmRetainedSamples: number;
  durationSeconds: number;
}

export interface RhythmEnergy {
  algorithmId: string;
  algorithmVersion: string;
  hopSeconds: number;
  values: number[];
}

export interface RhythmAnalysis {
  schemaVersion: typeof RHYTHM_SCHEMA_VERSION;
  analyzerId: typeof RHYTHM_ANALYZER_ID;
  analyzerVersion: typeof RHYTHM_ANALYZER_VERSION;
  sampleRate: number;
  hopSamples: number;
  windowSamples: number;
  latencySeconds: number;
  beats: RhythmBeat[];
  onsets: RhythmOnset[];
  bpm: number | null;
  bpmConfidence: number | null;
  tempoAmbiguity: RhythmTempoAmbiguity | null;
  meter: RhythmMeter | null;
  bars: RhythmBar[] | null;
  barSource: "detected" | "estimated" | null;
  noBeats: boolean;
  lowConfidence: boolean;
  energy: RhythmEnergy | null;
  resources?: RhythmResources;
}

export interface OnsetEnvelope {
  sampleRate: number;
  hopSamples: number;
  windowSamples: number;
  strength: Float32Array;
  rms: Float32Array;
  frameCount: number;
}

export const ENERGY_ALGORITHM_ID = "videobook-rms-energy";
export const ENERGY_ALGORITHM_VERSION = "1";
export const SECTION_DETECTOR_ID = "videobook-energy-sections";
export const SECTION_DETECTOR_VERSION = "1";
export const SECTION_LABELER_ID = "videobook-section-labeler";
export const SECTION_LABELER_VERSION = "1";

import { z } from "zod";

const beatSchema = z.object({ timeSeconds: z.number().finite().nonnegative(), confidence: z.number().min(0).max(1).nullable() });
export const musicEnergySchema = z.object({
  algorithmId: z.string().min(1),
  algorithmVersion: z.string().min(1),
  hopSeconds: z.number().finite().positive(),
  values: z.array(z.number().finite().min(0).max(1)).max(20000),
});
export type MusicEnergy = z.infer<typeof musicEnergySchema>;
export const sectionCandidateSchema = z.object({
  id: z.string().min(1).max(100),
  timeSeconds: z.number().finite().nonnegative().max(3600),
  quality: z.number().min(0).max(1),
});
export type SectionCandidate = z.infer<typeof sectionCandidateSchema>;
export const sectionDetectionSchema = z.object({
  algorithmId: z.string().min(1),
  algorithmVersion: z.string().min(1),
  candidates: z.array(sectionCandidateSchema).max(200),
});
export type SectionDetection = z.infer<typeof sectionDetectionSchema>;
export const musicAnalysisSchema = z.object({
  analysisId: z.string(),
  artifactId: z.string().uuid(),
  objectHash: z.string(),
  streamId: z.string().uuid(),
  durationSeconds: z.number().finite().positive().max(3600),
  analyzerVersion: z.string(),
  beats: z.array(beatSchema).max(24000),
  bpm: z.number().finite().positive().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  bars: z.array(beatSchema).max(24000).nullable(),
  beatsPerBar: z.number().int().min(1).max(16).nullable(),
  barSource: z.enum(["detected", "estimated"]).nullable().default(null),
  waveform: z.array(z.number().finite().min(0).max(1)).max(65536),
  lowConfidence: z.boolean(),
  energy: musicEnergySchema.nullable().default(null),
  sections: sectionDetectionSchema.nullable().default(null),
});
export type MusicAnalysis = z.infer<typeof musicAnalysisSchema>;

export const SECTION_LABEL_VALUES = ["intro", "verse", "chorus", "drop", "break", "bridge", "outro"] as const;
export const sectionLabelsSchema = z.object({
  schemaVersion: z.literal(1),
  analysisId: z.string(),
  artifactId: z.string().uuid(),
  objectHash: z.string(),
  streamId: z.string().uuid(),
  labeler: z.object({ id: z.string(), version: z.string(), model: z.string() }),
  boundaries: z.object({ algorithmId: z.string(), algorithmVersion: z.string() }),
  status: z.enum(["ready", "unavailable"]),
  reason: z.string().nullable().default(null),
  createdAt: z.number().finite().positive(),
  labels: z.array(z.object({
    candidateId: z.string().min(1).max(100),
    label: z.enum(SECTION_LABEL_VALUES),
    confidence: z.number().min(0).max(1),
    rationale: z.string().max(500),
  })).max(200).default([]),
});
export type SectionLabels = z.infer<typeof sectionLabelsSchema>;

export const rhythmMarkerSchema = z.object({
  id: z.string().min(1).max(100),
  timeSeconds: z.number().finite().nonnegative().max(3600),
  bar: z.boolean(),
  manual: z.boolean(),
});
export type RhythmMarker = z.infer<typeof rhythmMarkerSchema>;

export const rhythmSettingsSchema = z.object({
  masterClipId: z.string().uuid().nullable(),
  correction: z.object({
    objectHash: z.string(),
    analysisId: z.string().nullable(),
    markers: z.array(rhythmMarkerSchema).max(24000),
    bpm: z.number().finite().min(20).max(400).nullable(),
    beatsPerBar: z.number().int().min(1).max(16).nullable(),
  }).nullable(),
});
export type RhythmSettings = z.infer<typeof rhythmSettingsSchema>;
export interface RhythmState {
  revision: string;
  settings: RhythmSettings;
  canUndo: boolean;
  canRedo: boolean;
}

export interface SectionLabelsState {
  status: 'missing' | 'queued' | 'labeling' | 'ready' | 'unavailable' | 'cancelled' | 'failed';
  jobId: number | null;
  error: string | null;
  labels: SectionLabels | null;
}

export interface MusicAnalysisState {
  status: 'missing' | 'queued' | 'analyzing' | 'ready' | 'no-beats' | 'cancelled' | 'failed';
  analysisId: string;
  jobId: number | null;
  error: string | null;
  analysis: MusicAnalysis | null;
  sections?: SectionLabelsState | null;
}

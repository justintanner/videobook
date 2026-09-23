import { z } from "zod";

const beatSchema = z.object({ timeSeconds: z.number().finite().nonnegative(), confidence: z.number().min(0).max(1).nullable() });
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
});
export type MusicAnalysis = z.infer<typeof musicAnalysisSchema>;

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

export interface MusicAnalysisState {
  status: 'missing' | 'queued' | 'analyzing' | 'ready' | 'no-beats' | 'cancelled' | 'failed';
  analysisId: string;
  jobId: number | null;
  error: string | null;
  analysis: MusicAnalysis | null;
}

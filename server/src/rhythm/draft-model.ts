import { z } from "zod";
import type { EditIntent, EditPreview, Sequence } from "videobook-engine";

export const musicDraftOptionsSchema = z.object({
  track_id: z.string().uuid(),
  start_frame: z.number().int().nonnegative(),
  end_frame: z.number().int().positive(),
  sources: z.array(z.object({ artifact_id: z.string().uuid(), start_seconds: z.number().nonnegative().optional(), end_seconds: z.number().positive().optional() })).min(1).max(100),
  interval: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]),
  unit: z.enum(["beats", "bars"]),
  minimum_shot_frames: z.number().int().positive(),
  preserve_existing: z.boolean().default(true),
  preserve_clip_ids: z.array(z.string().uuid()).default([]),
  reuse_sources: z.boolean().default(false),
  allow_retiming: z.boolean().default(false),
});
export type MusicDraftOptions = z.infer<typeof musicDraftOptionsSchema>;
export interface MusicVideoDraft {
  plan: {
    planVersion: 1;
    planId: string;
    sourceSurface: "ui" | "slash" | "chat" | "system";
    actor: string;
    bookId: string;
    summary: string;
    normalizedReferences: Array<{ kind: "sequence" | "artifact"; targetId: string; revision?: string; objectHash?: string }>;
    stages: Array<{ kind: "edit"; stageId: string; summary: string; intent: EditIntent }>;
    confirmation: { required: true; policy: "always"; reason: string };
  };
  preview: EditPreview;
  sequence: Sequence;
  rhythmRevision: string;
  sequenceContentRevision: string;
  shots: Array<{ clipId: string; artifactId: string; startFrame: number; endFrame: number; sourceStartSeconds: number; sourceEndSeconds: number; speed: number }>;
  uncovered: Array<{ startFrame: number; endFrame: number }>;
  warnings: string[];
}

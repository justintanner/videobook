import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import {
  MiniMaxH3DurationSchema,
  MiniMaxH3ReferenceAspectRatioSchema,
  MiniMaxH3ReferenceToVideoRequestSchema,
  MiniMaxH3ResolutionSchema,
} from "@apicity/kie/zod";
import { modelSlug } from "@apicity/cost";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { apicityField, apicityStringArrayField, apicityStringField, apicityStringNumberField } from "./schema-from-apicity.js";
import { generationLabel } from "../artifact-label.js";
import { resolveAudioRef, resolveImageRef, resolveVideoRef, type RefInput } from "./_seedance2-shared.js";

const SLUG = modelSlug("kie", "minimax-h3/reference-to-video");

// Kie validates reference clip length at runtime — the published schema bounds
// only counts (docs/apicity-gaps.md §36): a live submit failed with "invalid
// param: video duration 29917 ms, expected [2000, 15000] ms". Check local
// `original` metadata before spending a task; unknown durations pass through
// (Kie stays the authority), and slashed refs are skipped because artifact
// metadata does not describe sibling files.
const REFERENCE_VIDEO_MIN_SECONDS = 2;
const REFERENCE_VIDEO_MAX_SECONDS = 15;

async function referenceVideoDurationError(engine: Engine, raw: string, assetId: string): Promise<string | null> {
  if (raw.includes("/")) return null;
  const meta = await engine.metadata.artifacts.read<{ duration?: unknown }>(assetId, "original");
  if (!meta.ok) return null;
  const duration = meta.value.duration;
  if (typeof duration !== "number" || duration <= 0) return null;
  if (duration >= REFERENCE_VIDEO_MIN_SECONDS && duration <= REFERENCE_VIDEO_MAX_SECONDS) return null;
  const shown = Math.round(duration * 10) / 10;
  return `Reference video ${raw} is ${shown}s; Kie accepts ${REFERENCE_VIDEO_MIN_SECONDS}-${REFERENCE_VIDEO_MAX_SECONDS}s reference videos for MiniMax H3 — trim it or pick a shorter clip`;
}

const generateMiniMaxH3R2vVideoSchema = {
  book_id: z.string().describe("Book id"),
  prompt: apicityStringField(MiniMaxH3ReferenceToVideoRequestSchema.shape.input.shape.prompt, "Video description (max 7000 chars)", { required: true }),
  image_refs: apicityStringArrayField(MiniMaxH3ReferenceToVideoRequestSchema.shape.input.shape.reference_image_urls, "Reference image assets (0-9; at least one image or video required)"),
  video_refs: apicityStringArrayField(MiniMaxH3ReferenceToVideoRequestSchema.shape.input.shape.reference_video_urls, "Reference video assets (0-3, each 2-15s; at least one image or video required)"),
  audio_refs: apicityStringArrayField(MiniMaxH3ReferenceToVideoRequestSchema.shape.input.shape.reference_audio_urls, "Reference audio assets (0-3)"),
  aspect_ratio: apicityField(MiniMaxH3ReferenceAspectRatioSchema, "Output aspect ratio: adaptive / 21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16"),
  duration: apicityStringNumberField(MiniMaxH3DurationSchema, "Video duration: 4-15 seconds (required)", { required: true }),
  resolution: apicityField(MiniMaxH3ResolutionSchema, "Output resolution: 768P / 2K (default 768P)"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateMiniMaxH3R2vVideoSchema>;

export function generateMiniMaxH3R2vVideoDef(engine: Engine): ToolDef {
  return {
    name: "generate_kie_minimax_h3_reference_to_video",
    description: "Generate a video from reference images, videos, and/or audio using MiniMax H3 reference-to-video. Creates a new video artifact and enqueues a background job.",
    schema: generateMiniMaxH3R2vVideoSchema,
    handler: async (args) => {
      const { book_id, prompt, image_refs, video_refs, audio_refs, aspect_ratio, duration, resolution } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }] };
      }

      const imageInputs: RefInput[] = [];
      for (const raw of image_refs ?? []) {
        if (raw.trim() === "") continue;
        const r = await resolveImageRef(engine, raw);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        imageInputs.push(r.value);
      }

      const videoInputs: RefInput[] = [];
      for (const raw of video_refs ?? []) {
        if (raw.trim() === "") continue;
        const r = await resolveVideoRef(engine, raw);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        const durationError = await referenceVideoDurationError(engine, raw, r.value.assetId);
        if (durationError) return { isError: true as const, content: [{ type: "text" as const, text: durationError }] };
        videoInputs.push(r.value);
      }

      const audioInputs: RefInput[] = [];
      for (const raw of audio_refs ?? []) {
        if (raw.trim() === "") continue;
        const r = await resolveAudioRef(engine, raw);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        audioInputs.push(r.value);
      }

      if (imageInputs.length === 0 && videoInputs.length === 0) {
        return { isError: true as const, content: [{ type: "text" as const, text: "At least one of image_refs or video_refs is required" }] };
      }

      const videoName = generationLabel(SLUG, prompt);
      const assetResult = await engine.artifacts.create("vid", videoName);
      if (!assetResult.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };
      }

      const { artifactId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceImageIds = imageInputs.map((i) => i.assetId);
      const sourceVideoIds = videoInputs.map((i) => i.assetId);
      const sourceAudioIds = audioInputs.map((i) => i.assetId);
      const jobId = `${SLUG}-r2v-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_minimax_h3_r2v_video",
        vidAssetId,
        vidAssetDir,
        bookId: book_id,
        prompt,
        duration,
        imageInputs,
        videoInputs,
        audioInputs,
        sourceImageIds,
        sourceVideoIds,
        sourceAudioIds,
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            vid_asset_id: vidAssetId,
            source_images: sourceImageIds,
            source_videos: sourceVideoIds,
            source_audios: sourceAudioIds,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}

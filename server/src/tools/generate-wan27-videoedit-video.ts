import type { Engine } from "videobook-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import {
  Wan27AspectRatioSchema,
  Wan27AudioSettingSchema,
  Wan27ResolutionSchema,
  Wan27VideoEditDurationValues,
  Wan27VideoEditRequestSchema,
} from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { apicityField, apicityStringField } from "./schema-from-apicity.js";
import {
  resolveImageRef,
  resolveVideoRef,
  type RefInput,
} from "./_seedance2-shared.js";
import { generationLabel } from "../artifact-label.js";

const WAN27_VIDEO_EDIT_DURATIONS = Wan27VideoEditDurationValues.map(String) as [string, ...string[]];

const generateWan27VideoeditVideoSchema = {
  book_id: z.string().describe("Book id"),
  prompt: apicityStringField(Wan27VideoEditRequestSchema.shape.input.shape.prompt, "Edit description (max 5000 chars)"),
  negative_prompt: apicityStringField(Wan27VideoEditRequestSchema.shape.input.shape.negative_prompt, "Negative prompt — things to avoid (max 500 chars)"),
  video_ref: z.string().describe("Source video artifact id to edit"),
  image_ref: z.string().optional().describe("Reference image artifact id for character/style guidance"),
  resolution: apicityField(Wan27ResolutionSchema, "Video resolution (default 1080p)"),
  aspect_ratio: apicityField(Wan27AspectRatioSchema, "Video aspect ratio (omit to match source)"),
  duration: z.enum(WAN27_VIDEO_EDIT_DURATIONS).optional().describe("Video duration in seconds (0=full source, or 2-10)"),
  audio_setting: apicityField(Wan27AudioSettingSchema, "Audio: auto (model decides) or origin (keep original)"),
  prompt_extend: apicityField(Wan27VideoEditRequestSchema.shape.input.shape.prompt_extend, "Intelligent prompt rewriting (default true)"),
  watermark: apicityField(Wan27VideoEditRequestSchema.shape.input.shape.watermark, "Add 'AI generated' watermark (default false)"),
  nsfw_checker: apicityField(Wan27VideoEditRequestSchema.shape.input.shape.nsfw_checker, "Content safety filter (default false)"),
  seed: apicityField(Wan27VideoEditRequestSchema.shape.input.shape.seed, "Random seed for reproducibility"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateWan27VideoeditVideoSchema>;

export function generateWan27VideoeditVideoDef(engine: Engine): ToolDef {
  return {
    name: "generate_kie_wan_2_7_edit_video",
    description: "Edit a video using Wan 2.7 Video Edit with optional reference image for character, clothing, or style guidance. Creates a new video artifact and enqueues a background job.",
    schema: generateWan27VideoeditVideoSchema,
    handler: async (args) => {
      const {
        book_id, prompt, negative_prompt,
        video_ref, image_ref,
        resolution, aspect_ratio, duration, audio_setting, prompt_extend, watermark, nsfw_checker, seed,
      } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      if (!video_ref) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "Wan 2.7 Video Edit requires video_ref" }],
        };
      }

      const videoResult = await resolveVideoRef(engine, video_ref);
      if (!videoResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: videoResult.error }] };
      const videoInput = videoResult.value;

      const MAX_INPUT_DURATION = 10;
      // Container-level mp4 durations almost never land cleanly on a whole
      // second, so a 10s preset typically produces ~10.01s. Allow a small
      // tolerance before failing.
      const DURATION_TOLERANCE = 0.05;
      const meta = await engine.metadata.artifacts.read<{ duration?: number }>(videoInput.assetId, "original");
      if (meta.ok && typeof meta.value.duration === "number" && meta.value.duration > MAX_INPUT_DURATION + DURATION_TOLERANCE) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Source video is ${meta.value.duration.toFixed(2)}s — Wan 2.7 Video Edit accepts at most ${MAX_INPUT_DURATION}s. Trim the video first.` }],
        };
      }

      let imageInput: RefInput | undefined;
      if (image_ref) {
        const r = await resolveImageRef(engine, image_ref);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        imageInput = r.value;
      }

      const videoName = generationLabel(modelSlug("kie", "wan/2-7-videoedit"), prompt);
      const assetResult = await engine.artifacts.create("vid", videoName);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }],
        };
      }

      const { artifactId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceImageIds = imageInput ? [imageInput.assetId] : [];
      const sourceVideoIds = [videoInput.assetId];
      const sourceAudioIds: string[] = [];

      const jobId = `${modelSlug("kie", "wan/2-7-videoedit")}-edit-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_wan27_videoedit_video",
        vidAssetId,
        vidAssetDir,
        bookId: book_id,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(negative_prompt !== undefined ? { negative_prompt } : {}),
        videoInput,
        ...(imageInput ? { imageInput } : {}),
        sourceImageIds,
        sourceVideoIds,
        sourceAudioIds,
        ...(resolution !== undefined ? { resolution } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(audio_setting !== undefined ? { audio_setting } : {}),
        ...(prompt_extend !== undefined ? { prompt_extend } : {}),
        ...(watermark !== undefined ? { watermark } : {}),
        ...(nsfw_checker !== undefined ? { nsfw_checker } : {}),
        ...(seed !== undefined ? { seed } : {}),
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

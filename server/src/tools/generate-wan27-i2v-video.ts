import type { Engine } from "videobook-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { Wan27ImageToVideoRequestSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { zodErrorToToolResult } from "./_shared.js";
import { apicityField, apicityStringField, apicityStringNumberField } from "./schema-from-apicity.js";
import {
  resolveAudioRef,
  resolveImageRef,
  resolveVideoRef,
  type RefInput,
} from "./_seedance2-shared.js";
import { generationLabel } from "../artifact-label.js";

const wan27I2v = Wan27ImageToVideoRequestSchema.shape.input.shape;

const generateWan27I2vVideoSchema = {
  book_id: z.string().describe("Book id"),
  prompt: apicityStringField(wan27I2v.prompt, "Video description (max 5000 chars)", { required: true }),
  negative_prompt: apicityStringField(wan27I2v.negative_prompt, "Negative prompt — things to avoid (max 500 chars)"),
  first_frame_ref: apicityStringField(wan27I2v.first_frame_url, "First frame image artifact id"),
  last_frame_ref: apicityStringField(wan27I2v.last_frame_url, "Last frame image artifact id"),
  first_clip_ref: apicityStringField(wan27I2v.first_clip_url, "Video artifact id for continuation"),
  driving_audio_ref: apicityStringField(wan27I2v.driving_audio_url, "Audio artifact id for audio-driven motion"),
  resolution: apicityField(wan27I2v.resolution, "Video resolution (default 1080p)"),
  duration: apicityStringNumberField(wan27I2v.duration, "Video duration in seconds (2-15)"),
  prompt_extend: apicityField(wan27I2v.prompt_extend, "Intelligent prompt rewriting (default true)"),
  watermark: apicityField(wan27I2v.watermark, "Add provider watermark to output (default false)"),
  nsfw_checker: apicityField(wan27I2v.nsfw_checker, "Content safety filter (default false)"),
  seed: apicityField(wan27I2v.seed, "Random seed for reproducibility"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateWan27I2vVideoSchema>;

export function generateWan27I2vVideoDef(fs: Engine): ToolDef {
  return {
    name: "generate_kie_wan_2_7_image_to_video",
    description: "Generate a video using Wan 2.7 Image to Video with first/last frame image control, clip continuation, or driving audio. Creates a new video artifact and enqueues a background job.",
    schema: generateWan27I2vVideoSchema,
    handler: async (args) => {
      const {
        book_id, prompt, negative_prompt,
        first_frame_ref, last_frame_ref, first_clip_ref, driving_audio_ref,
        resolution, duration, prompt_extend, watermark, nsfw_checker, seed,
      } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      // Apicity Wan27ImageToVideoRequestSchema refines enforce:
      //   - at least one of first_frame_url, last_frame_url, first_clip_url
      //   - first_clip_url cannot be combined with first_frame_url or last_frame_url
      // Only the refine-relevant fields are passed; slugs stand in for URLs
      // (apicity accepts any string), and unrelated fields (duration, seed)
      // are omitted so their per-field types don't need coercion here.
      const apicityCheck = Wan27ImageToVideoRequestSchema.safeParse({
        model: "wan/2-7-image-to-video",
        input: {
          prompt,
          ...(first_frame_ref ? { first_frame_url: first_frame_ref } : {}),
          ...(last_frame_ref ? { last_frame_url: last_frame_ref } : {}),
          ...(first_clip_ref ? { first_clip_url: first_clip_ref } : {}),
        },
      });
      if (!apicityCheck.success) return zodErrorToToolResult(apicityCheck.error);

      let firstFrame: RefInput | undefined;
      if (first_frame_ref) {
        const r = await resolveImageRef(fs, first_frame_ref, book_id);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        firstFrame = r.value;
      }

      let lastFrame: RefInput | undefined;
      if (last_frame_ref) {
        const r = await resolveImageRef(fs, last_frame_ref, book_id);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        lastFrame = r.value;
      }

      let firstClip: RefInput | undefined;
      if (first_clip_ref) {
        const r = await resolveVideoRef(fs, first_clip_ref, book_id);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        firstClip = r.value;
      }

      let drivingAudio: RefInput | undefined;
      if (driving_audio_ref) {
        const r = await resolveAudioRef(fs, driving_audio_ref, book_id);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        drivingAudio = r.value;
      }

      const videoName = generationLabel(modelSlug("kie", "wan/2-7-image-to-video"), prompt);
      const assetResult = await fs.artifacts.create("vid", videoName);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }],
        };
      }

      const { artifactId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceImageIds = [firstFrame?.assetId, lastFrame?.assetId].filter((v): v is string => v !== undefined);
      const sourceVideoIds = firstClip ? [firstClip.assetId] : [];
      const sourceAudioIds = drivingAudio ? [drivingAudio.assetId] : [];

      const jobId = `${modelSlug("kie", "wan/2-7-image-to-video")}-i2v-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_wan27_i2v_video",
        vidAssetId,
        vidAssetDir,
        bookId: book_id,
        prompt,
        ...(negative_prompt !== undefined ? { negative_prompt } : {}),
        ...(firstFrame ? { firstFrame } : {}),
        ...(lastFrame ? { lastFrame } : {}),
        ...(firstClip ? { firstClip } : {}),
        ...(drivingAudio ? { drivingAudio } : {}),
        sourceImageIds,
        sourceVideoIds,
        sourceAudioIds,
        ...(resolution !== undefined ? { resolution } : {}),
        ...(duration !== undefined ? { duration } : {}),
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

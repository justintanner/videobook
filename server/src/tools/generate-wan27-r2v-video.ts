import type { Engine } from "videobook-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { Wan27RefToVideoRequestSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { apicityField, apicityStringArrayField, apicityStringField, apicityStringNumberField } from "./schema-from-apicity.js";
import {
  resolveAudioRef,
  resolveImageRef,
  resolveVideoRef,
  type RefInput,
} from "./_seedance2-shared.js";
import { generationLabel } from "../artifact-label.js";

const wan27R2v = Wan27RefToVideoRequestSchema.shape.input.shape;

const generateWan27R2vVideoSchema = {
  book_id: z.string().describe("Book id"),
  prompt: apicityStringField(wan27R2v.prompt, "Video description (max 5000 chars)", { required: true }),
  negative_prompt: apicityStringField(wan27R2v.negative_prompt, "Negative prompt — things to avoid (max 500 chars)"),
  image_refs: apicityStringArrayField(wan27R2v.reference_image, "Reference image artifact ids (max 5 combined with videos)"),
  video_refs: apicityStringArrayField(wan27R2v.reference_video, "Reference video artifact ids (max 5 combined with images)"),
  first_frame_ref: apicityStringField(wan27R2v.first_frame, "First frame image artifact id (overrides aspect_ratio)"),
  audio_ref: apicityStringField(wan27R2v.reference_voice, "Voice timbre audio artifact id (wav/mp3, 1-10s)"),
  resolution: apicityField(wan27R2v.resolution, "Video resolution (default 1080p)"),
  aspect_ratio: apicityField(wan27R2v.aspect_ratio, "Video aspect ratio (ignored if first_frame_ref set)"),
  duration: apicityStringNumberField(wan27R2v.duration, "Video duration in seconds (2-10)"),
  prompt_extend: apicityField(wan27R2v.prompt_extend, "Intelligent prompt rewriting (default true)"),
  watermark: apicityField(wan27R2v.watermark, "Add provider watermark to output (default false)"),
  nsfw_checker: apicityField(wan27R2v.nsfw_checker, "Content safety filter (default false)"),
  seed: apicityField(wan27R2v.seed, "Random seed for reproducibility"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateWan27R2vVideoSchema>;

export function generateWan27R2vVideoDef(fs: Engine): ToolDef {
  return {
    name: "generate_kie_wan_2_7_reference_to_video",
    description: "Generate a video using Wan 2.7 Reference guided by reference images (0-5), videos (0-5), voice timbre, and optional first frame. Creates a new video artifact and enqueues a background job.",
    schema: generateWan27R2vVideoSchema,
    handler: async (args) => {
      const {
        book_id, prompt, negative_prompt,
        image_refs, video_refs, first_frame_ref, audio_ref,
        resolution, aspect_ratio, duration, prompt_extend, watermark, nsfw_checker, seed,
      } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      const imgs = image_refs ?? [];
      const vids = video_refs ?? [];
      const totalRefs = imgs.length + vids.length;

      if (totalRefs > 5) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Wan 2.7 Reference supports max 5 combined images+videos (got ${totalRefs})` }],
        };
      }

      const imageInputs: RefInput[] = [];
      for (const raw of imgs) {
        const r = await resolveImageRef(fs, raw, book_id);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        imageInputs.push(r.value);
      }

      const videoInputs: RefInput[] = [];
      for (const raw of vids) {
        const r = await resolveVideoRef(fs, raw, book_id);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        videoInputs.push(r.value);
      }

      let firstFrame: RefInput | undefined;
      if (first_frame_ref) {
        const r = await resolveImageRef(fs, first_frame_ref, book_id);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        firstFrame = r.value;
      }

      let voiceRef: RefInput | undefined;
      if (audio_ref) {
        const r = await resolveAudioRef(fs, audio_ref, book_id);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        voiceRef = r.value;
      }

      const videoName = generationLabel(modelSlug("kie", "wan/2-7-r2v"), prompt);
      const assetResult = await fs.artifacts.create("vid", videoName);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }],
        };
      }

      const { artifactId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceImageIds = [...imageInputs.map((i) => i.assetId), ...(firstFrame ? [firstFrame.assetId] : [])];
      const sourceVideoIds = videoInputs.map((i) => i.assetId);
      const sourceAudioIds = voiceRef ? [voiceRef.assetId] : [];

      const jobId = `${modelSlug("kie", "wan/2-7-r2v")}-r2v-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_wan27_r2v_video",
        vidAssetId,
        vidAssetDir,
        bookId: book_id,
        prompt,
        ...(negative_prompt !== undefined ? { negative_prompt } : {}),
        imageInputs,
        videoInputs,
        ...(firstFrame ? { firstFrame } : {}),
        ...(voiceRef ? { voiceRef } : {}),
        sourceImageIds,
        sourceVideoIds,
        sourceAudioIds,
        ...(resolution !== undefined ? { resolution } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
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

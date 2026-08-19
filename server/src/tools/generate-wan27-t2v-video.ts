import type { Engine } from "videobook-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { Wan27TextToVideoRequestSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { apicityField, apicityStringField, apicityStringNumberField } from "./schema-from-apicity.js";
import { resolveAudioRef, type RefInput } from "./_seedance2-shared.js";
import { generationLabel } from "../artifact-label.js";

const wan27T2v = Wan27TextToVideoRequestSchema.shape.input.shape;

const generateWan27T2vVideoSchema = {
  book_id: z.string().describe("Book id"),
  prompt: apicityStringField(wan27T2v.prompt, "Video description (max 5000 chars)", { required: true }),
  negative_prompt: apicityStringField(wan27T2v.negative_prompt, "Negative prompt — things to avoid (max 500 chars)"),
  audio_ref: apicityStringField(wan27T2v.audio_url, "Optional custom audio artifact id"),
  resolution: apicityField(wan27T2v.resolution, "Video resolution (default 1080p)"),
  aspect_ratio: apicityField(wan27T2v.ratio, "Video aspect ratio"),
  duration: apicityStringNumberField(wan27T2v.duration, "Video duration in seconds (2-15)"),
  prompt_extend: apicityField(wan27T2v.prompt_extend, "Intelligent prompt rewriting (default true)"),
  watermark: apicityField(wan27T2v.watermark, "Add provider watermark to output (default false)"),
  nsfw_checker: apicityField(wan27T2v.nsfw_checker, "Content safety filter (default false)"),
  seed: apicityField(wan27T2v.seed, "Random seed for reproducibility"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateWan27T2vVideoSchema>;

export function generateWan27T2vVideoDef(engine: Engine): ToolDef {
  return {
    name: "generate_kie_wan_2_7_text_to_video",
    description: "Generate a video from a prompt using Wan 2.7 Text to Video. Supports optional custom audio. Creates a new video artifact and enqueues a background job.",
    schema: generateWan27T2vVideoSchema,
    handler: async (args) => {
      const {
        book_id, prompt, negative_prompt, audio_ref,
        resolution, aspect_ratio, duration, prompt_extend, watermark, nsfw_checker, seed,
      } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      let audioRef: RefInput | undefined;
      if (audio_ref) {
        const r = await resolveAudioRef(engine, audio_ref);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        audioRef = r.value;
      }

      const videoName = generationLabel(modelSlug("kie", "wan/2-7-text-to-video"), prompt);
      const assetResult = await engine.artifacts.create("vid", videoName);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }],
        };
      }

      const { artifactId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceAudioIds = audioRef ? [audioRef.assetId] : [];

      const jobId = `${modelSlug("kie", "wan/2-7-text-to-video")}-t2v-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_wan27_t2v_video",
        vidAssetId,
        vidAssetDir,
        bookId: book_id,
        prompt,
        ...(negative_prompt !== undefined ? { negative_prompt } : {}),
        ...(audioRef ? { audioRef } : {}),
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
            source_audios: sourceAudioIds,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}

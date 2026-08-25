import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import { FalWan3p0TextToVideoRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { modelSlug } from "@apicity/cost";
import { apicityField, apicityStringField } from "./schema-from-apicity.js";
import { generationLabel } from "../artifact-label.js";

const base = FalWan3p0TextToVideoRequestSchema.shape;

const schema = {
  book_id: z.string().describe("Book id"),
  prompt: apicityStringField(base.prompt, "Video description", { required: true }),
  aspect_ratio: apicityField(base.aspect_ratio, "Output aspect ratio"),
  resolution: apicityField(base.resolution, "Output resolution"),
  duration: apicityField(base.duration, "Video duration in seconds (2-30)", { required: true }),
  audio: apicityField(base.audio, "Generate accompanying audio"),
  enable_prompt_expansion: apicityField(base.enable_prompt_expansion, "Enable prompt expansion"),
  enable_thinking: apicityField(base.enable_thinking, "Enable thinking mode"),
  enable_safety_checker: apicityField(base.enable_safety_checker, "Enable safety checker"),
  seed: apicityField(base.seed, "Seed for deterministic output"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateWan30T2vFalDef(engine: Engine): ToolDef {
  return {
    name: "generate_fal_wan_3_0_text_to_video",
    description: "Generate a video via fal.ai using Alibaba Wan 3.0 from a text prompt only. Creates a new video artifact and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { book_id, prompt, aspect_ratio, resolution, duration, audio, enable_prompt_expansion, enable_thinking, enable_safety_checker, seed } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const assetResult = await engine.artifacts.create("vid", generationLabel(modelSlug("kie", "wan/3-0-video"), prompt));
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };

      const { artifactId: vidAssetId, path: vidAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "wan/3-0-video")}-t2v-${vidAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_wan30_t2v_fal",
        vidAssetId,
        vidAssetDir,
        bookId: book_id,
        prompt,
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        duration,
        ...(audio !== undefined ? { audio } : {}),
        ...(enable_prompt_expansion !== undefined ? { enable_prompt_expansion } : {}),
        ...(enable_thinking !== undefined ? { enable_thinking } : {}),
        ...(enable_safety_checker !== undefined ? { enable_safety_checker } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ vid_asset_id: vidAssetId, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}

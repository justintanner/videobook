import type { VideocityFs } from "videocity-engine";
import { z, type ZodRawShape } from "zod";
import { queue } from "../queue.js";
import { type PendingTask } from "videocity-engine";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { slugify } from "./_fal-shared.js";

type ModelSpec = {
  toolType: string;
  taskType: PendingTask["taskType"];
  slugPrefix: string;
  jobPrefix: string;
};

const MODELS: readonly ModelSpec[] = [
  {
    toolType: "generate_nano_banana_pro_fal",
    taskType: "fal_nano_banana_pro",
    slugPrefix: "nano-banana",
    jobPrefix: "fal-nano-banana-pro",
  },
  {
    toolType: "generate_wan27_pro_fal",
    taskType: "fal_wan27_pro",
    slugPrefix: "wan27pro",
    jobPrefix: "fal-wan27-pro",
  },
  {
    toolType: "generate_seedream_v5_lite_fal",
    taskType: "fal_seedream_v5_lite",
    slugPrefix: "seedream",
    jobPrefix: "fal-seedream-v5-lite",
  },
  {
    toolType: "generate_grok_imagine_image_fal",
    taskType: "fal_grok_imagine_image",
    slugPrefix: "grok",
    jobPrefix: "fal-grok-imagine-image",
  },
] as const;

const schema = {
  prompt: z.string().describe("Text prompt for image generation"),
  project_slug: z.string().describe("Project slug"),
  source_script_id: z.string().optional().describe("Optional script asset that originated this prompt"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

type EnqueueOutcome =
  | { model: string; img_asset_id: string; job_id: string }
  | { model: string; error: string };

async function enqueueModel(
  fs: VideocityFs,
  spec: ModelSpec,
  prompt: string,
  projectSlug: string,
  sourceScriptId: string | undefined,
  promptSlug: string,
): Promise<EnqueueOutcome> {
  const assetResult = await fs.createAsset(
    "img",
    `${spec.slugPrefix}-${promptSlug}`,
    projectSlug,
  );
  if (!assetResult.ok) {
    return { model: spec.toolType, error: assetResult.error.message };
  }
  const { assetId: imgAssetId, path: imgAssetDir } = assetResult.value;

  const jobId = `${spec.jobPrefix}-${imgAssetId}-${Date.now()}`;
  await queue.enqueue(jobId, {
    type: spec.toolType,
    imgAssetId,
    imgAssetDir,
    projectSlug,
    prompt,
  } as unknown as Record<string, unknown>);

  return { model: spec.toolType, img_asset_id: imgAssetId, job_id: jobId };
}

export function genImagesAllDef(fs: VideocityFs): ToolDef {
  return {
    name: "gen_images_all_models",
    description:
      "Generate a text-to-image across leading t2i models in parallel (Nano Banana Pro, Wan 2.7 Pro, Seedream v5 Lite, Grok Imagine). Creates one img-* asset per model and enqueues background jobs.",
    schema,
    handler: async (args) => {
      const { prompt, project_slug, source_script_id } = args as Args;

      if (!prompt.trim()) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "prompt must not be empty" }],
        };
      }
      if (!process.env.FAL_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }],
        };
      }

      const promptSlug = slugify(prompt) || String(Date.now());
      const results = await Promise.all(
        MODELS.map((spec) => enqueueModel(fs, spec, prompt, project_slug, source_script_id, promptSlug)),
      );

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ results }) }],
      };
    },
  };
}

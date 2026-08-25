import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import { queue } from "../queue.js";
import { type PendingTask } from "videobook-engine";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { generationLabel } from "../artifact-label.js";

type ModelSpec = {
  canonicalName: string;
  jobType: string;
  taskType: PendingTask["taskType"];
  modelName: string;
  jobPrefix: string;
};

const MODELS: readonly ModelSpec[] = [
  {
    canonicalName: "generate_fal_nano_banana_pro_text_to_image",
    jobType: "generate_nano_banana_pro_fal",
    taskType: "fal_nano_banana_pro",
    modelName: "nano-banana",
    jobPrefix: "fal-nano-banana-pro",
  },
  {
    canonicalName: "generate_fal_seedream_v5_lite_text_to_image",
    jobType: "generate_seedream_v5_lite_fal",
    taskType: "fal_seedream_v5_lite",
    modelName: "seedream",
    jobPrefix: "fal-seedream-v5-lite",
  },
  {
    canonicalName: "generate_fal_grok_imagine_text_to_image",
    jobType: "generate_grok_imagine_image_fal",
    taskType: "fal_grok_imagine_image",
    modelName: "grok",
    jobPrefix: "fal-grok-imagine-image",
  },
] as const;

const schema = {
  prompt: z.string().describe("Text prompt for image generation"),
  book_id: z.string().describe("Book id"),
  source_script_id: z.string().optional().describe("Optional script asset that originated this prompt"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

type EnqueueOutcome =
  | { model: string; img_asset_id: string; job_id: string }
  | { model: string; error: string };

async function enqueueModel(
  engine: Engine,
  spec: ModelSpec,
  prompt: string,
  bookId: string,
  // Accepted for parity with the tool schema; the per-model jobs do not record
  // provenance yet, so nothing downstream reads it.
  _sourceScriptId: string | undefined,
): Promise<EnqueueOutcome> {
  const assetResult = await engine.artifacts.create("img", generationLabel(spec.modelName, prompt));
  if (!assetResult.ok) {
    return { model: spec.canonicalName, error: assetResult.error.message };
  }
  const { artifactId: imgAssetId, path: imgAssetDir } = assetResult.value;

  const jobId = `${spec.jobPrefix}-${imgAssetId}-${Date.now()}`;
  await queue.enqueue(jobId, {
    type: spec.jobType,
    imgAssetId,
    imgAssetDir,
    bookId,
    prompt,
  } as unknown as Record<string, unknown>);

  return { model: spec.canonicalName, img_asset_id: imgAssetId, job_id: jobId };
}

export function genImagesAllDef(engine: Engine): ToolDef {
  return {
    name: "generate_image_model_comparison",
    description:
      "Generate a text-to-image across leading t2i models in parallel (Nano Banana Pro, Seedream v5 Lite, Grok Imagine). Creates one image artifact per model and enqueues background jobs.",
    schema,
    handler: async (args) => {
      const { prompt, book_id, source_script_id } = args as Args;

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

      const results = await Promise.all(
        MODELS.map((spec) => enqueueModel(engine, spec, prompt, book_id, source_script_id)),
      );

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ results }) }],
      };
    },
  };
}

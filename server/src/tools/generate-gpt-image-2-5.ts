import type { Engine } from "videobook-engine";
import { z } from "zod";
import { GPT_IMAGE_2_5_MODELS, GPT_IMAGE_2_5_REFERENCE_SCHEMA, gptImage25Request } from "../gpt-image-2-5.js";
import type { GptImage25Variant } from "../gpt-image-2-5.js";
import { generationLabel } from "../artifact-label.js";
import { queue } from "../queue.js";
import { zodErrorToToolResult } from "./_shared.js";
import { resolveImageRefs } from "./_image-inputs.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";

function generateGptImage25Def(engine: Engine, variant: GptImage25Variant): ToolDef {
  const config = GPT_IMAGE_2_5_MODELS[variant];
  const input = config.textSchema.shape.input.shape;
  const schema = {
    book_id: z.string().describe("Book id"),
    prompt: input.prompt.describe("Image generation or editing prompt"),
    image_refs: GPT_IMAGE_2_5_REFERENCE_SCHEMA
      .describe("Optional reference image artifact ids (up to 16)"),
    aspect_ratio: input.aspect_ratio.optional().describe("Output aspect ratio"),
    resolution: input.resolution.optional().describe("Output resolution; 27:16, 16:27, 9:8 and 8:9 support 1K only"),
    background: input.background.describe("Transparent, opaque, or automatic background"),
    _provider: z.literal("kie").optional().describe("Provider key"),
  };

  return {
    name: config.tool,
    description: `Generate or edit an image using ${config.label} with up to 16 optional reference images. Creates an image artifact and enqueues a background job.`,
    schema,
    handler: async (args) => {
      const { book_id, prompt, image_refs = [], aspect_ratio, resolution, background } = args as SchemaArgs<typeof schema>;
      if (!process.env.KIE_API_KEY) {
        return { isError: true, content: [{ type: "text", text: "KIE_API_KEY environment variable is not set" }] };
      }

      const input = { prompt, aspect_ratio, resolution, background };
      const parsed = gptImage25Request(variant, input, image_refs);
      if (!parsed.success) return zodErrorToToolResult(parsed.error);
      const resolved = await resolveImageRefs(engine, image_refs);
      if (!resolved.ok) {
        return { isError: true, content: [{ type: "text", text: resolved.error }] };
      }

      const created = await engine.artifacts.create("img", generationLabel(`gpt-image-2-5-${variant}`, prompt));
      if (!created.ok) {
        return { isError: true, content: [{ type: "text", text: created.error.message }] };
      }
      const { artifactId: imgAssetId, path: imgAssetDir } = created.value;
      const jobId = `gpt-image-2-5-${variant}-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_gpt_image_2_5",
        variant,
        input,
        imageInputs: resolved.inputs,
        sourceImageIds: resolved.sourceImageIds,
        imgAssetId,
        imgAssetDir,
        bookId: book_id,
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ img_asset_id: imgAssetId, job_id: jobId, status: "enqueued" }) }],
      };
    },
  };
}

export function generateGptImage25Defs(engine: Engine): ToolDef[] {
  return [generateGptImage25Def(engine, "flare"), generateGptImage25Def(engine, "sunburst")];
}

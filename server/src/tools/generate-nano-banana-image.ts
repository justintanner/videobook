import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-engine";
import { z, type ZodRawShape } from "zod";
import { NanoBananaOutputFormatSchema, NanoBananaProRequestSchema, NanoBananaResolutionSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import { QUEUED_TASK_ID } from "clipfirst-engine";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { zodErrorToToolResult } from "./_shared.js";
import { resolveImageSlugs } from "./_image-inputs.js";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30)
    .replace(/-$/, "");
}

const nanoBananaProInputSchema = NanoBananaProRequestSchema.shape.input.shape;

const generateNanoBananaImageSchema = {
  prompt: z.string().describe("Text prompt for image generation"),
  project_slug: z.string().describe("Project slug"),
  image_slugs: z.array(z.string()).optional().describe("0-8 @img-* slugs for reference images"),
  aspect_ratio: z.enum(nanoBananaProInputSchema.aspect_ratio.unwrap().options).optional().describe("Aspect ratio"),
  resolution: z.enum(NanoBananaResolutionSchema.options).optional().describe("Output resolution"),
  output_format: z.enum(NanoBananaOutputFormatSchema.options).optional().describe("Output image format"),
  output_prefix: z.enum(["img", "char"]).optional().describe("Asset prefix for the output (default: img). Use 'char' to bundle into a character asset."),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie', 'xai')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateNanoBananaImageSchema>;

export function generateNanoBananaImageDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_nano_banana_image",
    description: "Generate an image using the nano-banana-pro model. Creates a new img- asset and enqueues a background job. Prompt is required; reference images are optional.",
    schema: generateNanoBananaImageSchema,
    handler: async (args) => {
      const { prompt, project_slug, image_slugs, aspect_ratio, resolution, output_format, output_prefix } = args as Args;
      const prefix = output_prefix ?? "img";

      const rawSlugs = image_slugs ?? [];

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      // Apicity NanoBananaProRequestSchema enforces image_input .max(8).
      const apicityCheck = NanoBananaProRequestSchema.safeParse({
        model: "nano-banana-pro",
        input: {
          prompt,
          ...(rawSlugs.length > 0 ? { image_input: rawSlugs.map((s) => s.replace(/^@/, "")) } : {}),
          ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
          ...(resolution !== undefined ? { resolution } : {}),
          ...(output_format !== undefined ? { output_format } : {}),
        },
      });
      if (!apicityCheck.success) return zodErrorToToolResult(apicityCheck.error);

      const resolved = await resolveImageSlugs(fs, rawSlugs, project_slug);
      if (!resolved.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };
      }
      const { inputs: imageInputs, sourceImageIds } = resolved;

      const assetName = slugify(prompt);
      const assetResult = await fs.createAsset(prefix, assetName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: imgAssetId, path: imgAssetDir } = assetResult.value;

      {
        const _ptResult = await fs.pendingTasks.write(project_slug, {
          taskId: QUEUED_TASK_ID,
          taskType: "nano_banana_image",
          assetId: imgAssetId,
          assetDir: imgAssetDir,
          meta: { sourceImageIds, prompt },
        });
        if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${imgAssetId}: ${_ptResult.error.message}`);
      }

      const jobId = `nano-banana-image-${imgAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_nano_banana_image",
        prompt,
        imageInputs,
        imgAssetId,
        imgAssetDir,
        sourceImageIds,
        projectSlug: project_slug,
        ...(aspect_ratio !== undefined ? { aspectRatio: aspect_ratio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(output_format !== undefined ? { outputFormat: output_format } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            img_asset_id: imgAssetId,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}

export function registerGenerateNanoBananaImageTool(server: McpServer, fs: ClipfirstFs): void {
  const def = generateNanoBananaImageDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}

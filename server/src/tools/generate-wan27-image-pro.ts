import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z, type ZodRawShape } from "zod";
import { Wan27ImageAspectRatioSchema, Wan27ImageResolutionSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import { writePendingTask, QUEUED_TASK_ID } from "../jobs/pending-task.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageSlugs } from "./_image-inputs.js";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30)
    .replace(/-$/, "");
}

const generateWan27ImageProSchema = {
  prompt: z.string().describe("Text prompt for image generation (max 5000 chars)"),
  project_slug: z.string().describe("Project slug"),
  image_slugs: z.array(z.string()).optional().describe("0-9 @img-* slugs for reference images"),
  aspect_ratio: z.enum(Wan27ImageAspectRatioSchema.options).optional().describe("Output aspect ratio (default 1:1)"),
  resolution: z.enum(Wan27ImageResolutionSchema.options).optional().describe("Output resolution (default 2K)"),
  seed: z.number().optional().describe("Random seed (0-2147483647)"),
  nsfw_checker: z.boolean().optional().describe("Content safety filter (default false)"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateWan27ImageProSchema>;

export function generateWan27ImageProDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_wan27_image_pro",
    description: "Generate an image using Wan 2.7 Image Pro. Creates a new img- asset and enqueues a background job. Prompt is required; reference images are optional (0-9).",
    schema: generateWan27ImageProSchema,
    handler: async (args) => {
      const { prompt, project_slug, image_slugs, aspect_ratio, resolution, seed, nsfw_checker } = args as Args;

      const rawSlugs = image_slugs ?? [];

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      if (rawSlugs.length > 9) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "Maximum 9 reference images allowed" }],
        };
      }

      const resolved = await resolveImageSlugs(fs, rawSlugs, project_slug);
      if (!resolved.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };
      }
      const { inputs: imageInputs, sourceImageIds } = resolved;

      const assetName = slugify(prompt);
      const assetResult = await fs.createAsset("img", assetName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: imgAssetId, path: imgAssetDir } = assetResult.value;

      await writePendingTask(fs, imgAssetId, project_slug, {
        taskId: QUEUED_TASK_ID,
        taskType: "wan27_image_pro",
        assetId: imgAssetId,
        assetDir: imgAssetDir,
        projectSlug: project_slug,
        createdAt: new Date().toISOString(),
        meta: { sourceImageIds, prompt },
      });

      const jobId = `wan27-image-pro-${imgAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_wan27_image_pro",
        prompt,
        imageInputs,
        imgAssetId,
        imgAssetDir,
        sourceImageIds,
        projectSlug: project_slug,
        ...(aspect_ratio !== undefined ? { aspectRatio: aspect_ratio } : {}),
        resolution: resolution ?? "2K",
        ...(seed !== undefined ? { seed } : {}),
        ...(nsfw_checker !== undefined ? { nsfwChecker: nsfw_checker } : {}),
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

export function registerGenerateWan27ImageProTool(server: McpServer, fs: ClipfirstFs): void {
  const def = generateWan27ImageProDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}

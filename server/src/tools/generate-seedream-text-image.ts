import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z, type ZodRawShape } from "zod";
import { SeedreamTextToImageRequestSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import { writePendingTask, QUEUED_TASK_ID } from "../jobs/pending-task.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { zodErrorToToolResult } from "./_shared.js";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30)
    .replace(/-$/, "");
}

const seedreamInputSchema = SeedreamTextToImageRequestSchema.shape.input.shape;

const generateSeedreamTextImageSchema = {
  prompt: z.string().describe("Text description of the image to generate (3-3000 chars)"),
  project_slug: z.string().describe("Project slug"),
  aspect_ratio: z.enum(seedreamInputSchema.aspect_ratio.unwrap().options).optional().describe("Output aspect ratio (default 1:1)"),
  quality: z.enum(seedreamInputSchema.quality.unwrap().options).optional().describe("Output quality (basic=2K, high=4K, default basic)"),
  nsfw_checker: z.boolean().optional().describe("Content safety filter"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie', 'fal')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateSeedreamTextImageSchema>;

export function generateSeedreamTextImageDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_seedream_text_image",
    description: "Generate an image from text using ByteDance Seedream 5 Lite via Kie. Creates a new img- asset and enqueues a background job.",
    schema: generateSeedreamTextImageSchema,
    handler: async (args) => {
      const { prompt, project_slug, aspect_ratio, quality, nsfw_checker } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      const apicityCheck = SeedreamTextToImageRequestSchema.safeParse({
        model: "seedream/5-lite-text-to-image",
        input: {
          prompt,
          ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
          ...(quality !== undefined ? { quality } : {}),
          ...(nsfw_checker !== undefined ? { nsfw_checker } : {}),
        },
      });
      if (!apicityCheck.success) return zodErrorToToolResult(apicityCheck.error);

      const assetName = `seedream-${slugify(prompt) || String(Date.now())}`;
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
        taskType: "seedream_text_image",
        assetId: imgAssetId,
        assetDir: imgAssetDir,
        projectSlug: project_slug,
        createdAt: new Date().toISOString(),
        meta: { prompt, sourceImageIds: [] },
      });

      const jobId = `seedream-text-image-${imgAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_seedream_text_image",
        prompt,
        imgAssetId,
        imgAssetDir,
        projectSlug: project_slug,
        ...(aspect_ratio !== undefined ? { aspectRatio: aspect_ratio } : {}),
        ...(quality !== undefined ? { quality } : {}),
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

export function registerGenerateSeedreamTextImageTool(server: McpServer, fs: ClipfirstFs): void {
  const def = generateSeedreamTextImageDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}

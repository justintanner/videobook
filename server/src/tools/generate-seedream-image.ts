import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z, type ZodRawShape } from "zod";
import { SeedreamImageToImageRequestSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import { writePendingTask, QUEUED_TASK_ID } from "../jobs/pending-task.js";
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

const seedreamInputSchema = SeedreamImageToImageRequestSchema.shape.input.shape;

const generateSeedreamImageSchema = {
  prompt: z.string().describe("Modification prompt (3-3000 chars)"),
  project_slug: z.string().describe("Project slug"),
  image_slugs: z.array(z.string()).describe("1-14 @img-* slugs for reference images"),
  aspect_ratio: z.enum(seedreamInputSchema.aspect_ratio.unwrap().options).optional().describe("Output aspect ratio (default 1:1)"),
  quality: z.enum(seedreamInputSchema.quality.options).optional().describe("Output quality (basic=2K, high=4K). Defaults to basic."),
  nsfw_checker: z.boolean().optional().describe("Content safety filter"),
  output_prefix: z.enum(["img", "char"]).optional().describe("Asset prefix for the output (default: img). Use 'char' to bundle into a character asset."),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie', 'fal')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateSeedreamImageSchema>;

export function generateSeedreamImageDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_seedream_image",
    description: "Edit or compose images using ByteDance Seedream 5 Lite via Kie with 1-14 @img-* reference inputs. Creates a new img- asset and enqueues a background job.",
    schema: generateSeedreamImageSchema,
    handler: async (args) => {
      const { prompt, project_slug, image_slugs, aspect_ratio, quality, nsfw_checker, output_prefix } = args as Args;
      const prefix = output_prefix ?? "img";

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      const rawSlugs = image_slugs ?? [];

      // Apicity schema validation — accept bare IDs (no @ prefix) as stand-ins
      // for URLs; the real URLs are resolved post-upload in the job handler.
      const apicityCheck = SeedreamImageToImageRequestSchema.safeParse({
        model: "seedream/5-lite-image-to-image",
        input: {
          prompt,
          image_urls: rawSlugs.map((s) => s.replace(/^@/, "")),
          ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
          ...(quality !== undefined ? { quality } : {}),
          ...(nsfw_checker !== undefined ? { nsfw_checker } : {}),
        },
      });
      if (!apicityCheck.success) return zodErrorToToolResult(apicityCheck.error);

      const resolved = await resolveImageSlugs(fs, rawSlugs, project_slug);
      if (!resolved.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };
      }
      const { inputs: imageInputs, sourceImageIds } = resolved;

      const assetName = `seedream-${slugify(prompt) || String(Date.now())}`;
      const assetResult = await fs.createAsset(prefix, assetName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: imgAssetId, path: imgAssetDir } = assetResult.value;

      await writePendingTask(fs, imgAssetId, project_slug, {
        taskId: QUEUED_TASK_ID,
        taskType: "seedream_image",
        assetId: imgAssetId,
        assetDir: imgAssetDir,
        projectSlug: project_slug,
        createdAt: new Date().toISOString(),
        meta: { prompt, sourceImageIds },
      });

      const jobId = `seedream-image-${imgAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_seedream_image",
        prompt,
        imageInputs,
        imgAssetId,
        imgAssetDir,
        sourceImageIds,
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
            source_images: sourceImageIds,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}

export function registerGenerateSeedreamImageTool(server: McpServer, fs: ClipfirstFs): void {
  const def = generateSeedreamImageDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs, AssetManifestFile } from "clipfirst-fs";
import { z, type ZodRawShape } from "zod";
import { GptImage2ImageToImageRequestSchema } from "@apicity/kie/zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import { writePendingTask, QUEUED_TASK_ID } from "../jobs/pending-task.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { zodErrorToToolResult } from "./_shared.js";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

function findImageFile(files: AssetManifestFile[]): AssetManifestFile | null {
  const images = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
  return images.find((f) => f.name.startsWith("original")) ?? images[0] ?? null;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30)
    .replace(/-$/, "");
}

const gptImageToImageInputSchema = GptImage2ImageToImageRequestSchema.shape.input.shape;

const generateGptImageSchema = {
  prompt: z.string().describe("Text prompt for image editing"),
  project_slug: z.string().describe("Project slug"),
  image_slugs: z.array(z.string()).describe("1-16 @img-* slugs for reference images"),
  aspect_ratio: z.enum(gptImageToImageInputSchema.aspect_ratio.unwrap().options).optional().describe("Aspect ratio"),
  nsfw_checker: z.boolean().optional().describe("Enable NSFW content filter"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateGptImageSchema>;

export function generateGptImageDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_gpt_image",
    description: "Generate an image using GPT Image 2.0 editing with 1-16 reference images. Creates a new img- asset and enqueues a background job.",
    schema: generateGptImageSchema,
    handler: async (args) => {
      const { prompt, project_slug, image_slugs, aspect_ratio, nsfw_checker } = args as Args;

      const ids = (image_slugs ?? []).map((s) => s.replace(/^@/, ""));

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      // Apicity GptImage2ImageToImageRequestSchema enforces input_urls .min(1).max(16).
      const apicityCheck = GptImage2ImageToImageRequestSchema.safeParse({
        model: "gpt-image-2-image-to-image",
        input: {
          prompt,
          input_urls: ids,
          ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
          ...(nsfw_checker !== undefined ? { nsfw_checker } : {}),
        },
      });
      if (!apicityCheck.success) return zodErrorToToolResult(apicityCheck.error);

      const imageInputs: Array<{ assetId: string; filename: string }> = [];
      const sourceImageIds: string[] = [];

      for (const id of ids) {
        if (!id.startsWith("img-")) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `image_slugs entries must be img-* assets, got: ${id}` }],
          };
        }

        const manifestResult = await fs.getManifest(id, project_slug);
        if (!manifestResult.ok) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: manifestResult.error.message }],
          };
        }

        const manifest = manifestResult.value;
        const imageFile = findImageFile(manifest.files);
        if (!imageFile) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `No image file found in asset ${id}` }],
          };
        }

        imageInputs.push({ assetId: id, filename: imageFile.name });
        sourceImageIds.push(id);
      }

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
        taskType: "gpt_image",
        assetId: imgAssetId,
        assetDir: imgAssetDir,
        projectSlug: project_slug,
        createdAt: new Date().toISOString(),
        meta: { sourceImageIds, prompt },
      });

      const jobId = `gpt-image-${imgAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_gpt_image",
        prompt,
        imageInputs,
        imgAssetId,
        imgAssetDir,
        sourceImageIds,
        projectSlug: project_slug,
        ...(aspect_ratio !== undefined ? { aspectRatio: aspect_ratio } : {}),
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

export function registerGenerateGptImageTool(server: McpServer, fs: ClipfirstFs): void {
  const def = generateGptImageDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}

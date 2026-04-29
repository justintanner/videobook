import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-engine";
import { z, type ZodRawShape } from "zod";
import { GptImage2TextToImageRequestSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import { QUEUED_TASK_ID } from "clipfirst-engine";
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

const gptImageTextInputSchema = GptImage2TextToImageRequestSchema.shape.input.shape;

const generateGptImageTextSchema = {
  prompt: z.string().describe("Text prompt for image generation (1-20000 chars)"),
  project_slug: z.string().describe("Project slug"),
  aspect_ratio: z.enum(gptImageTextInputSchema.aspect_ratio.unwrap().options).optional().describe("Aspect ratio"),
  nsfw_checker: z.boolean().optional().describe("Enable NSFW content filter"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateGptImageTextSchema>;

export function generateGptImageTextDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_gpt_image_text",
    description: "Generate an image using GPT Image 2.0 text-to-image. Creates a new img- asset and enqueues a background job.",
    schema: generateGptImageTextSchema,
    handler: async (args) => {
      const { prompt, project_slug, aspect_ratio, nsfw_checker } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      const apicityCheck = GptImage2TextToImageRequestSchema.safeParse({
        model: "gpt-image-2-text-to-image",
        input: {
          prompt,
          ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
          ...(nsfw_checker !== undefined ? { nsfw_checker } : {}),
        },
      });
      if (!apicityCheck.success) return zodErrorToToolResult(apicityCheck.error);

      const assetName = slugify(prompt);
      const assetResult = await fs.createAsset("img", assetName, project_slug);
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
          taskType: "gpt_image_text",
          assetId: imgAssetId,
          assetDir: imgAssetDir,
          meta: { sourceImageIds: [], prompt },
        });
        if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${imgAssetId}: ${_ptResult.error.message}`);
      }

      const jobId = `gpt-image-text-${imgAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_gpt_image_text",
        prompt,
        imgAssetId,
        imgAssetDir,
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

export function registerGenerateGptImageTextTool(server: McpServer, fs: ClipfirstFs): void {
  const def = generateGptImageTextDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}

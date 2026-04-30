import type { ClipfirstFs } from "clipfirst-engine";
import { z, type ZodRawShape } from "zod";
import { GrokTextToImageRequestSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30)
    .replace(/-$/, "");
}

const grokTextToImageInputSchema = GrokTextToImageRequestSchema.shape.input.shape;

const generateGrokImagineTextImageSchema = {
  prompt: z.string().describe("Text prompt for image generation"),
  project_slug: z.string().describe("Project slug"),
  aspect_ratio: z.enum(grokTextToImageInputSchema.aspect_ratio.unwrap().options).optional().describe("Aspect ratio"),
  enable_pro: z.boolean().optional().describe("Quality mode when true, speed mode when false"),
  nsfw_checker: z.boolean().optional().describe("Enable NSFW content safety filter (default false)"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie', 'xai')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateGrokImagineTextImageSchema>;

export function generateGrokImagineTextImageDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_grok_imagine_text_image",
    description:
      "Generate an image from a text prompt using Grok Imagine. Creates a new img- asset and enqueues a background job. No reference images needed.",
    schema: generateGrokImagineTextImageSchema,
    handler: async (args) => {
      const { prompt, project_slug, aspect_ratio, enable_pro, nsfw_checker, _provider } = args as Args;

      const isXai = _provider !== undefined && _provider.startsWith("xai");
      const requiredKey = isXai ? "XAI_API_KEY" : "KIE_API_KEY";
      if (!process.env[requiredKey]) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `${requiredKey} environment variable is not set` }],
        };
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

      const jobId = `grok-imagine-text-${imgAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_grok_imagine_text_image",
        prompt,
        imgAssetId,
        imgAssetDir,
        projectSlug: project_slug,
        ...(aspect_ratio !== undefined ? { aspectRatio: aspect_ratio } : {}),
        ...(enable_pro !== undefined ? { enablePro: enable_pro } : {}),
        ...(nsfw_checker !== undefined ? { nsfwChecker: nsfw_checker } : {}),
        ...(_provider !== undefined ? { _provider } : {}),
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

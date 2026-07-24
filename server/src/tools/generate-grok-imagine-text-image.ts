import type { Engine } from "videobook-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { GrokTextToImageRequestSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { apicityField, apicityStringField } from "./schema-from-apicity.js";

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
  prompt: apicityStringField(grokTextToImageInputSchema.prompt, "Text prompt for image generation", { required: true }),
  project_slug: z.string().describe("Project slug"),
  aspect_ratio: apicityField(grokTextToImageInputSchema.aspect_ratio, "Aspect ratio"),
  enable_pro: apicityField(grokTextToImageInputSchema.enable_pro, "Quality mode when true, speed mode when false"),
  nsfw_checker: apicityField(grokTextToImageInputSchema.nsfw_checker, "Enable NSFW content safety filter (default false)"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie', 'xai')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateGrokImagineTextImageSchema>;

export function generateGrokImagineTextImageDef(fs: Engine): ToolDef {
  return {
    name: "generate_kie_grok_imagine_text_to_image",
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

      const assetName = `${modelSlug("kie", "grok-imagine/text-to-image")}-${slugify(prompt) || String(Date.now())}`;
      const assetResult = await fs.artifacts.create("img", assetName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }],
        };
      }

      const { slug: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `${modelSlug("kie", "grok-imagine/text-to-image")}-text-${imgAssetId}-${Date.now()}`;

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

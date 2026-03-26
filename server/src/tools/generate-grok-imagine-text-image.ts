import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import { queue } from "../queue.js";
import { writePendingTask, QUEUED_TASK_ID } from "../jobs/pending-task.js";
import type { ToolDef } from "./tool-def.js";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30)
    .replace(/-$/, "");
}

export function generateGrokImagineTextImageDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_grok_imagine_text_image",
    description:
      "Generate an image from a text prompt using Grok Imagine text-to-image. Creates a new img- asset and enqueues a background job. No reference images needed.",
    schema: {
      prompt: z.string().describe("Text prompt for image generation"),
      project_slug: z.string().describe("Project slug"),
      aspect_ratio: z
        .enum(["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9"])
        .optional()
        .describe("Aspect ratio"),
      resolution: z.enum(["1k", "2k"]).optional().describe("Output resolution"),
    },
    handler: async (args) => {
      const { prompt, project_slug, aspect_ratio, resolution } = args as {
        prompt: string;
        project_slug: string;
        aspect_ratio?: string;
        resolution?: "1k" | "2k";
      };

      if (!process.env.XAI_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "XAI_API_KEY environment variable is not set" }],
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

      await writePendingTask(fs, imgAssetId, project_slug, {
        taskId: QUEUED_TASK_ID,
        taskType: "grok_imagine_text",
        assetId: imgAssetId,
        assetDir: imgAssetDir,
        projectSlug: project_slug,
        createdAt: new Date().toISOString(),
        meta: { prompt },
      });

      const jobId = `grok-imagine-text-${imgAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_grok_imagine_text_image",
        prompt,
        imgAssetId,
        imgAssetDir,
        projectSlug: project_slug,
        ...(aspect_ratio !== undefined ? { aspectRatio: aspect_ratio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
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

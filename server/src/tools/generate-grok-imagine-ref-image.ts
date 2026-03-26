import type { ClipfirstFs, AssetManifestFile } from "clipfirst-fs";
import { z } from "zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import { writePendingTask, QUEUED_TASK_ID } from "../jobs/pending-task.js";
import type { ToolDef } from "./tool-def.js";

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

type RefImageInput = {
  assetId: string;
  filename: string;
};

export function generateGrokImagineRefImageDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_grok_imagine_ref_image",
    description:
      "Generate an image using xAI Grok Imagine with optional reference images (0-4). Creates a new img- asset and enqueues a background job.",
    schema: {
      prompt: z.string().describe("Text prompt for image generation"),
      project_slug: z.string().describe("Project slug"),
      image_slugs: z
        .array(z.string())
        .optional()
        .describe("Optional reference image slugs (0-4, e.g., ['@img-sunset'])"),
      aspect_ratio: z
        .enum(["1:1", "2:3", "3:2", "16:9", "9:16"])
        .optional()
        .describe("Aspect ratio"),
      _provider: z.string().optional().describe("Provider key (always xai)"),
    },
    handler: async (args) => {
      const { prompt, project_slug, image_slugs, aspect_ratio } = args as {
        prompt: string;
        project_slug: string;
        image_slugs?: string[];
        aspect_ratio?: string;
      };

      if (!process.env.XAI_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "XAI_API_KEY environment variable is not set" }],
        };
      }

      // Resolve reference images (0-4)
      const refImages: RefImageInput[] = [];
      const slugs = image_slugs ?? [];

      for (const rawSlug of slugs.slice(0, 4)) {
        const assetId = rawSlug.replace(/^@/, "");
        if (!assetId.startsWith("img-")) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `Reference asset must start with img-, got: ${assetId}` }],
          };
        }

        const manifestResult = await fs.getManifest(assetId, project_slug);
        if (!manifestResult.ok) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: manifestResult.error.message }],
          };
        }

        const imageFile = findImageFile(manifestResult.value.files);
        if (!imageFile) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `No image file found in asset ${assetId}` }],
          };
        }

        refImages.push({ assetId, filename: imageFile.name });
      }

      // Create output asset
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
        taskType: "grok_imagine_ref",
        assetId: imgAssetId,
        assetDir: imgAssetDir,
        projectSlug: project_slug,
        createdAt: new Date().toISOString(),
        meta: { prompt, refCount: refImages.length },
      });

      const jobId = `grok-imagine-ref-${imgAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_grok_imagine_ref_image",
        prompt,
        imgAssetId,
        imgAssetDir,
        projectSlug: project_slug,
        refImages,
        ...(aspect_ratio !== undefined ? { aspectRatio: aspect_ratio } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            img_asset_id: imgAssetId,
            ref_images: refImages.length,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}

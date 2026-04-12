import type { ClipfirstFs, AssetManifestFile } from "clipfirst-fs";
import type { XaiVideoGenerateRequest } from "@apicity/xai";
import { z, type ZodRawShape } from "zod";
import { GrokImagineDurationSchema, GrokImagineResolutionSchema } from "@apicity/kie/zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import { writePendingTask, QUEUED_TASK_ID } from "../jobs/pending-task.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";

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

type XaiVideoAspectRatio = NonNullable<XaiVideoGenerateRequest["aspect_ratio"]>;

const XaiVideoAspectRatioSchema = z.union([
  z.literal("1:1"),
  z.literal("16:9"),
  z.literal("9:16"),
  z.literal("4:3"),
  z.literal("3:4"),
  z.literal("3:2"),
  z.literal("2:3"),
]) satisfies z.ZodType<XaiVideoAspectRatio>;

const generateGrokImagineRefVideoSchema = {
  prompt: z.string().describe("Text prompt for video generation"),
  project_slug: z.string().describe("Project slug"),
  image_slugs: z
    .array(z.string())
    .optional()
    .describe("Optional reference image slugs (0-4, e.g., ['@img-sunset'])"),
  duration: z.enum(GrokImagineDurationSchema.options).optional().describe("Video duration in seconds"),
  resolution: z.enum(GrokImagineResolutionSchema.options).optional().describe("Output resolution"),
  aspect_ratio: XaiVideoAspectRatioSchema.optional().describe("Video aspect ratio"),
  _provider: z.string().optional().describe("Provider key (always xai)"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateGrokImagineRefVideoSchema>;

export function generateGrokImagineRefVideoDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_grok_imagine_ref_video",
    description:
      "Generate a video using xAI Grok Imagine with optional reference images (0-4). Creates a new vid- asset and enqueues a background job.",
    schema: generateGrokImagineRefVideoSchema,
    handler: async (args) => {
      const { prompt, project_slug, image_slugs, duration, resolution, aspect_ratio } = args as Args;

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

      // Create output video asset
      const assetName = slugify(prompt);
      const assetResult = await fs.createAsset("vid", assetName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;

      await writePendingTask(fs, vidAssetId, project_slug, {
        taskId: QUEUED_TASK_ID,
        taskType: "xai_grok_imagine_ref_video",
        assetId: vidAssetId,
        assetDir: vidAssetDir,
        projectSlug: project_slug,
        createdAt: new Date().toISOString(),
        meta: { prompt, refCount: refImages.length },
      });

      const jobId = `grok-imagine-ref-video-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_grok_imagine_ref_video",
        prompt,
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        refImages,
        ...(duration !== undefined ? { duration } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(aspect_ratio !== undefined ? { aspectRatio: aspect_ratio } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            vid_asset_id: vidAssetId,
            ref_images: refImages.length,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}

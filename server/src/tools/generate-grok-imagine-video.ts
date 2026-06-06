import { modelSlug } from "@apicity/cost";
import type { VideocityFs, AssetManifestFile } from "vc-engine";
import { z, type ZodRawShape } from "zod";
import { GrokVideo15AspectRatioSchema, GrokImagineResolutionSchema } from "@apicity/kie/zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

function findImageFile(files: AssetManifestFile[]): AssetManifestFile | null {
  const images = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
  return images.find((f) => f.name.startsWith("original")) ?? images[0] ?? null;
}

function deriveVideoName(firstAssetId: string): string {
  const baseName = firstAssetId.startsWith("img-") ? firstAssetId.slice(4) : firstAssetId;
  return `grok-${baseName}`;
}

const generateGrokImagineVideoSchema = {
  image_slugs: z.array(z.string()).min(1).max(1).optional().describe("Exactly one reference image asset slug (e.g., ['@img-sunset'])"),
  asset_id: z.string().optional().describe("Single image asset ID (must be img-*); back-compat alias for image_slugs[0]"),
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().max(4096).optional().describe("Optional prompt to guide video generation (max 4096 chars)"),
  duration: z.number().int().min(1).max(15).optional().describe("Video duration in seconds (1-15)"),
  resolution: z.enum(GrokImagineResolutionSchema.options).optional().describe("Output resolution"),
  aspect_ratio: z.enum(GrokVideo15AspectRatioSchema.options).optional().describe("Output aspect ratio"),
  nsfw_checker: z.boolean().optional().describe("Enable NSFW content safety filter (default true)"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie', 'xai')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateGrokImagineVideoSchema>;

export function generateGrokImagineVideoDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_grok_imagine_video",
    description: "Generate a video from image asset(s) using Kie Grok Imagine Video 1.5 Preview. Creates a new vid- asset and enqueues a background job.",
    schema: generateGrokImagineVideoSchema,
    handler: async (args) => {
      const { asset_id: rawAssetId, image_slugs, project_slug, prompt, duration, resolution, aspect_ratio, nsfw_checker, _provider } = args as Args;

      const isXai = _provider !== undefined && _provider.startsWith("xai");
      const requiredKey = isXai ? "XAI_API_KEY" : "KIE_API_KEY";
      if (!process.env[requiredKey]) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `${requiredKey} environment variable is not set` }],
        };
      }

      // Normalize asset_id back-compat into image_slugs
      const slugs = (image_slugs && image_slugs.length > 0)
        ? image_slugs.map((s) => s.replace(/^@/, ""))
        : (rawAssetId ? [rawAssetId.replace(/^@/, "")] : []);

      if (slugs.length === 0) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "image_slugs or asset_id is required" }],
        };
      }
      if (slugs.length !== 1) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "generate_grok_imagine_video supports exactly one image" }],
        };
      }

      const assetIds: string[] = [];
      const imageFilenames: string[] = [];
      for (const assetId of slugs) {
        if (!assetId.startsWith("img-")) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `image asset must start with img-, got: ${assetId}` }],
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
        assetIds.push(assetId);
        imageFilenames.push(imageFile.name);
      }

      const videoName = deriveVideoName(assetIds[0]);
      const assetResult = await fs.createAsset("vid", videoName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;

      const jobId = `${modelSlug("kie", "grok-imagine-video-1-5-preview")}-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_grok_imagine_video",
        sourceImageIds: assetIds,
        imageFilenames,
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(nsfw_checker !== undefined ? { nsfw_checker } : {}),
        ...(_provider !== undefined ? { _provider } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            vid_asset_id: vidAssetId,
            source_images: assetIds,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}

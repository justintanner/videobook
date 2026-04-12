import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs, AssetManifestFile } from "clipfirst-fs";
import { z, type ZodRawShape } from "zod";
import { GrokImageToVideoRequestSchema, GrokImagineDurationSchema, GrokImagineModeSchema, GrokImagineResolutionSchema } from "@apicity/kie/zod";
import { join, extname } from "node:path";
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

function deriveVideoName(imageAssetId: string): string {
  const baseName = imageAssetId.startsWith("img-") ? imageAssetId.slice(4) : imageAssetId;
  return `grok-${baseName}`;
}

const grokImageToVideoInputSchema = GrokImageToVideoRequestSchema.shape.input.shape;

const generateGrokImagineVideoSchema = {
  asset_id: z.string().optional().describe("Image asset ID (must be img-*)"),
  image_slugs: z.array(z.string()).optional().describe("Image slugs (e.g., ['@img-sunset']). Used as fallback when asset_id is not provided."),
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().optional().describe("Optional prompt to guide video generation"),
  mode: z.enum(GrokImagineModeSchema.options).optional().describe("Generation mode"),
  duration: z.enum(GrokImagineDurationSchema.options).optional().describe("Video duration in seconds"),
  resolution: z.enum(GrokImagineResolutionSchema.options).optional().describe("Output resolution"),
  aspect_ratio: z.enum(grokImageToVideoInputSchema.aspect_ratio.unwrap().options).optional().describe("Output aspect ratio"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie', 'xai')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateGrokImagineVideoSchema>;

export function generateGrokImagineVideoDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_grok_imagine_video",
    description: "Generate a video from an image asset using Grok Imagine image-to-video. Creates a new vid- asset and enqueues a background job.",
    schema: generateGrokImagineVideoSchema,
    handler: async (args) => {
      const { asset_id: rawAssetId, image_slugs, project_slug, prompt, mode, duration, resolution, aspect_ratio, _provider } = args as Args;

      // Derive asset_id from image_slugs if not provided directly
      const asset_id = rawAssetId ?? (image_slugs?.[0]?.replace(/^@/, "") || undefined);

      const isXai = _provider !== undefined && _provider.startsWith("xai");
      const requiredKey = isXai ? "XAI_API_KEY" : "KIE_API_KEY";
      if (!process.env[requiredKey]) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `${requiredKey} environment variable is not set` }],
        };
      }

      if (!asset_id) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "asset_id or image_slugs with at least one entry is required" }],
        };
      }

      if (!asset_id.startsWith("img-")) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `asset_id must start with img-, got: ${asset_id}` }],
        };
      }

      const manifestResult = await fs.getManifest(asset_id, project_slug);
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
          content: [{ type: "text" as const, text: `No image file found in asset ${asset_id}` }],
        };
      }

      const imagePath = join(manifest.path, imageFile.name);
      const videoName = deriveVideoName(asset_id);
      const assetResult = await fs.createAsset("vid", videoName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;

      await writePendingTask(fs, vidAssetId, project_slug, {
        taskId: QUEUED_TASK_ID,
        taskType: "grok_imagine_video",
        assetId: vidAssetId,
        assetDir: vidAssetDir,
        projectSlug: project_slug,
        createdAt: new Date().toISOString(),
        meta: { sourceImageId: asset_id, ...(prompt !== undefined ? { prompt } : {}) },
      });

      const jobId = `grok-imagine-video-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_grok_imagine_video",
        imagePath,
        imageFilename: imageFile.name,
        vidAssetId,
        vidAssetDir,
        sourceImageId: asset_id,
        projectSlug: project_slug,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(_provider !== undefined ? { _provider } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            vid_asset_id: vidAssetId,
            source_image: asset_id,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}

export function registerGenerateGrokImagineVideoTool(server: McpServer, fs: ClipfirstFs): void {
  const def = generateGrokImagineVideoDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}

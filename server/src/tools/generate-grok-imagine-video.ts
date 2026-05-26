import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { modelSlug } from "@apicity/cost";
import type { VideocityFs, AssetManifestFile } from "vc-engine";
import { z, type ZodRawShape } from "zod";
import { GrokImageToVideoRequestSchema, GrokImagineModeSchema, GrokImagineResolutionSchema } from "@apicity/kie/zod";
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

const grokImageToVideoInputSchema = GrokImageToVideoRequestSchema.shape.input.shape;

// Mirror of GrokImageToVideoDurationSchema (z.string().regex(/^([6-9]|[12][0-9]|30)$/)) —
// materialized as a contiguous 6-30 string enum so the MCP JSON schema can drive a
// snap-to-enum slider in the client.
const GROK_I2V_DURATIONS = Array.from({ length: 25 }, (_, i) => String(i + 6)) as [string, ...string[]];

const generateGrokImagineVideoSchema = {
  image_slugs: z.array(z.string()).min(1).max(7).optional().describe("1-7 reference image asset slugs (e.g., ['@img-sunset'])"),
  asset_id: z.string().optional().describe("Single image asset ID (must be img-*); back-compat alias for image_slugs[0]"),
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().max(5000).optional().describe("Optional prompt to guide video generation (max 5000 chars)"),
  mode: z.enum(GrokImagineModeSchema.options).optional().describe("Generation mode: fun / normal / spicy. Spicy is only available via task_id; external images force normal."),
  duration: z.enum(GROK_I2V_DURATIONS).optional().describe("Video duration in seconds (6-30)"),
  resolution: z.enum(GrokImagineResolutionSchema.options).optional().describe("Output resolution"),
  aspect_ratio: z.enum(grokImageToVideoInputSchema.aspect_ratio.unwrap().options).optional().describe("Output aspect ratio (ignored for single-image input)"),
  task_id: z.string().max(100).optional().describe("Reference task ID for spicy mode without external images (kie only)"),
  index: z.number().int().min(0).max(5).optional().describe("Frame index (0-5) when reusing a prior task_id (kie only)"),
  nsfw_checker: z.boolean().optional().describe("Enable NSFW content safety filter (default false)"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie', 'xai')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateGrokImagineVideoSchema>;

export function generateGrokImagineVideoDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_grok_imagine_video",
    description: "Generate a video from 1-7 image asset(s) using Grok Imagine image-to-video. Multiple images act as references. Creates a new vid- asset and enqueues a background job.",
    schema: generateGrokImagineVideoSchema,
    handler: async (args) => {
      const { asset_id: rawAssetId, image_slugs, project_slug, prompt, mode, duration, resolution, aspect_ratio, task_id, index, nsfw_checker, _provider } = args as Args;

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

      if (slugs.length === 0 && !task_id) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "image_slugs (1-7), asset_id, or task_id is required" }],
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

      const videoName = assetIds.length > 0 ? deriveVideoName(assetIds[0]) : `grok-task-${task_id?.slice(0, 12) ?? Date.now()}`;
      const assetResult = await fs.createAsset("vid", videoName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;

      const jobId = `${modelSlug("kie", "grok-imagine/text-to-video")}-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_grok_imagine_video",
        sourceImageIds: assetIds,
        imageFilenames,
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(task_id !== undefined ? { task_id } : {}),
        ...(index !== undefined ? { index } : {}),
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

export function registerGenerateGrokImagineVideoTool(server: McpServer, fs: VideocityFs): void {
  const def = generateGrokImagineVideoDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}

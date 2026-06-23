import type { VideocityFs, AssetManifestFile } from "videocity-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { HappyHorseResolutionSchema } from "@apicity/kie/zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { apicityField } from "./schema-from-apicity.js";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

function findImageFile(files: AssetManifestFile[]): AssetManifestFile | null {
  const images = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
  return images.find((f) => f.name.startsWith("original")) ?? images[0] ?? null;
}

const generateHappyhorseI2vVideoSchema = {
  project_slug: z.string().describe("Project slug"),
  first_frame_slug: z.string().describe("First frame image asset (e.g., @img-start)"),
  prompt: z.string().optional().describe("Optional video description (max 5000 chars / 2500 Chinese chars)"),
  resolution: apicityField(HappyHorseResolutionSchema, "Output resolution: 720p / 1080p (default 1080p)"),
  duration: z.string().optional().describe("Video duration in seconds (3-15, default 5)"),
  seed: z.number().int().optional().describe("Random seed for reproducibility"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateHappyhorseI2vVideoSchema>;

export function generateHappyhorseI2vVideoDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_happyhorse_i2v_video",
    description: "Generate a video from a single first-frame image using HappyHorse image-to-video. Creates a new vid- asset and enqueues a background job.",
    schema: generateHappyhorseI2vVideoSchema,
    handler: async (args) => {
      const { project_slug, first_frame_slug, prompt, resolution, duration, seed } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }] };
      }

      const assetId = first_frame_slug.replace(/^@/, "");
      if (!assetId.startsWith("img-") && !assetId.startsWith("char-")) {
        return { isError: true as const, content: [{ type: "text" as const, text: `first_frame_slug must be an img-* or char-* asset, got: ${assetId}` }] };
      }
      const manifest = await fs.getManifest(assetId, project_slug);
      if (!manifest.ok) return { isError: true as const, content: [{ type: "text" as const, text: manifest.error.message }] };
      const file = findImageFile(manifest.value.files);
      if (!file) return { isError: true as const, content: [{ type: "text" as const, text: `No image file found in asset ${assetId}` }] };

      const videoName = `${modelSlug("kie", "happyhorse/image-to-video")}-${assetId.replace(/^img-/, "")}`;
      const assetResult = await fs.createAsset("vid", videoName, project_slug);
      if (!assetResult.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };
      }

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceImageIds = [assetId];
      const jobId = `${modelSlug("kie", "happyhorse/image-to-video")}-i2v-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_happyhorse_i2v_video",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        firstFrame: { assetId, filename: file.name },
        sourceImageIds,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ vid_asset_id: vidAssetId, source_images: sourceImageIds, job_id: jobId, status: "enqueued" }),
        }],
      };
    },
  };
}

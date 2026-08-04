import type { Engine, ArtifactManifestFile } from "videobook-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import {
  HappyHorse11ImageToVideoRequestSchema,
  HappyHorseDurationSchema,
  HappyHorseResolutionSchema,
} from "@apicity/kie/zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { apicityField, apicityStringField, apicityStringNumberField } from "./schema-from-apicity.js";

const SLUG = modelSlug("kie", "happyhorse-1-1/image-to-video");

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

function findImageFile(files: ArtifactManifestFile[]): ArtifactManifestFile | null {
  const images = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
  return images.find((f) => f.name.startsWith("original")) ?? images[0] ?? null;
}

const generateHappyhorseI2vVideoSchema = {
  book_id: z.string().describe("Book id"),
  first_frame_ref: z.string().describe("First frame image artifact id"),
  prompt: apicityStringField(HappyHorse11ImageToVideoRequestSchema.shape.input.shape.prompt, "Optional video description (max 5000 chars / 2500 Chinese chars)"),
  resolution: apicityField(HappyHorseResolutionSchema, "Output resolution: 720p / 1080p (default 1080p)"),
  duration: apicityStringNumberField(HappyHorseDurationSchema, "Video duration in seconds (3-15, default 5)"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateHappyhorseI2vVideoSchema>;

export function generateHappyhorseI2vVideoDef(fs: Engine): ToolDef {
  return {
    name: "generate_kie_happyhorse_1_1_image_to_video",
    description: "Generate a video from a single first-frame image using HappyHorse image-to-video. Creates a new video artifact and enqueues a background job.",
    schema: generateHappyhorseI2vVideoSchema,
    handler: async (args) => {
      const { book_id, first_frame_ref, prompt, resolution, duration } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }] };
      }

      const assetId = first_frame_ref.replace(/^@/, "");
      const artifact = fs.artifacts.get(assetId);
      if (!artifact.ok) return { isError: true as const, content: [{ type: "text" as const, text: artifact.error.message }] };
      if (artifact.value.kind !== "image") {
        return { isError: true as const, content: [{ type: "text" as const, text: `first_frame_ref must be an image artifact, got ${artifact.value.kind}: ${assetId}` }] };
      }
      const manifest = await fs.files.manifest(assetId);
      if (!manifest.ok) return { isError: true as const, content: [{ type: "text" as const, text: manifest.error.message }] };
      const file = findImageFile(manifest.value.files);
      if (!file) return { isError: true as const, content: [{ type: "text" as const, text: `No image file found in asset ${assetId}` }] };

      const videoName = `${SLUG}-${assetId}`;
      const assetResult = await fs.artifacts.create("vid", videoName);
      if (!assetResult.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };
      }

      const { artifactId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceImageIds = [assetId];
      const jobId = `${SLUG}-i2v-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_happyhorse_i2v_video",
        vidAssetId,
        vidAssetDir,
        bookId: book_id,
        firstFrame: { assetId, filename: file.name },
        sourceImageIds,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(duration !== undefined ? { duration } : {}),
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

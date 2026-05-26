import type { VideocityFs, AssetManifestFile } from "vc-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { HappyHorseAudioSettingSchema, HappyHorseResolutionSchema } from "@apicity/kie/zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import { findVideoFile } from "vc-engine";
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

type RefInput = { assetId: string; filename: string };

const generateHappyhorseVideoeditVideoSchema = {
  project_slug: z.string().describe("Project slug"),
  video_slug: z.string().describe("Source video asset to edit (3-60s, e.g., @vid-scene)"),
  prompt: z.string().describe("Edit instruction (max 5000 chars / 2500 Chinese chars)"),
  image_slugs: z.array(z.string()).max(5).optional().describe("0-5 optional reference images for character/style guidance"),
  resolution: z.enum(HappyHorseResolutionSchema.options).optional().describe("Output resolution: 720p / 1080p (default 1080p)"),
  audio_setting: z.enum(HappyHorseAudioSettingSchema.options).optional().describe("Audio: auto (model decides) or origin (keep original, default auto)"),
  seed: z.number().int().optional().describe("Random seed for reproducibility"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateHappyhorseVideoeditVideoSchema>;

export function generateHappyhorseVideoeditVideoDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_happyhorse_videoedit_video",
    description: "Edit a source video using HappyHorse video-edit with optional reference images for character/style. Creates a new vid- asset and enqueues a background job.",
    schema: generateHappyhorseVideoeditVideoSchema,
    handler: async (args) => {
      const { project_slug, video_slug, prompt, image_slugs, resolution, audio_setting, seed } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }] };
      }

      const videoAssetId = video_slug.replace(/^@/, "");
      if (!videoAssetId.startsWith("vid-")) {
        return { isError: true as const, content: [{ type: "text" as const, text: `video_slug must be a vid-* asset, got: ${videoAssetId}` }] };
      }
      const videoManifest = await fs.getManifest(videoAssetId, project_slug);
      if (!videoManifest.ok) return { isError: true as const, content: [{ type: "text" as const, text: videoManifest.error.message }] };
      const videoFile = findVideoFile(videoManifest.value.files);
      if (!videoFile) return { isError: true as const, content: [{ type: "text" as const, text: `No video file found in asset ${videoAssetId}` }] };

      const imageInputs: RefInput[] = [];
      for (const raw of image_slugs ?? []) {
        const assetId = raw.replace(/^@/, "");
        if (!assetId.startsWith("img-") && !assetId.startsWith("char-")) {
          return { isError: true as const, content: [{ type: "text" as const, text: `image_slugs entries must be img-* or char-* assets, got: ${assetId}` }] };
        }
        const manifest = await fs.getManifest(assetId, project_slug);
        if (!manifest.ok) return { isError: true as const, content: [{ type: "text" as const, text: manifest.error.message }] };
        const file = findImageFile(manifest.value.files);
        if (!file) return { isError: true as const, content: [{ type: "text" as const, text: `No image file found in asset ${assetId}` }] };
        imageInputs.push({ assetId, filename: file.name });
      }

      const videoName = `${modelSlug("kie", "happyhorse/video-edit")}-${slugify(prompt) || String(Date.now())}`;
      const assetResult = await fs.createAsset("vid", videoName, project_slug);
      if (!assetResult.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };
      }

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceVideoIds = [videoAssetId];
      const sourceImageIds = imageInputs.map((i) => i.assetId);
      const jobId = `${modelSlug("kie", "happyhorse/video-edit")}-edit-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_happyhorse_videoedit_video",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        prompt,
        sourceVideo: { assetId: videoAssetId, filename: videoFile.name },
        imageInputs,
        sourceVideoIds,
        sourceImageIds,
        ...(resolution !== undefined ? { resolution } : {}),
        ...(audio_setting !== undefined ? { audio_setting } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ vid_asset_id: vidAssetId, source_videos: sourceVideoIds, source_images: sourceImageIds, job_id: jobId, status: "enqueued" }),
        }],
      };
    },
  };
}

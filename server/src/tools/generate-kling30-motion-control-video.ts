import type { VideocityFs, AssetManifestFile } from "videocity-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { KlingMotionControlRequestSchema } from "@apicity/kie/zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import { findVideoFile } from "videocity-engine";
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

const motionControlInput = KlingMotionControlRequestSchema.shape.input.shape;

const generateKling30MotionControlVideoSchema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().optional().describe("Optional motion description"),
  character_image_slugs: z.array(z.string()).min(1).describe("Character image @slugs (input_urls)"),
  motion_video_slugs: z.array(z.string()).min(1).describe("Motion reference video @slugs (video_urls)"),
  mode: z.enum(motionControlInput.mode.unwrap().options).optional().describe("Output resolution: 720p / 1080p (default 720p)"),
  character_orientation: z.enum(motionControlInput.character_orientation.unwrap().options).optional().describe("Character orientation source: video / image (default video)"),
  background_source: z.enum(motionControlInput.background_source.unwrap().options).optional().describe("Background source: input_video / input_image (default input_video)"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateKling30MotionControlVideoSchema>;

export function generateKling30MotionControlVideoDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_kling30_motion_control_video",
    description: "Apply motion from reference videos to character images using Kling 3.0 motion-control. Creates a new vid- asset and enqueues a background job.",
    schema: generateKling30MotionControlVideoSchema,
    handler: async (args) => {
      const {
        project_slug, prompt,
        character_image_slugs, motion_video_slugs,
        mode, character_orientation, background_source,
      } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      const imageInputs: RefInput[] = [];
      for (const raw of character_image_slugs) {
        const assetId = raw.replace(/^@/, "");
        if (!assetId.startsWith("img-") && !assetId.startsWith("char-")) {
          return { isError: true as const, content: [{ type: "text" as const, text: `character_image_slugs entries must be img-* or char-* assets, got: ${assetId}` }] };
        }
        const manifest = await fs.getManifest(assetId, project_slug);
        if (!manifest.ok) return { isError: true as const, content: [{ type: "text" as const, text: manifest.error.message }] };
        const file = findImageFile(manifest.value.files);
        if (!file) return { isError: true as const, content: [{ type: "text" as const, text: `No image file found in asset ${assetId}` }] };
        imageInputs.push({ assetId, filename: file.name });
      }

      const videoInputs: RefInput[] = [];
      for (const raw of motion_video_slugs) {
        const assetId = raw.replace(/^@/, "");
        if (!assetId.startsWith("vid-")) {
          return { isError: true as const, content: [{ type: "text" as const, text: `motion_video_slugs entries must be vid-* assets, got: ${assetId}` }] };
        }
        const manifest = await fs.getManifest(assetId, project_slug);
        if (!manifest.ok) return { isError: true as const, content: [{ type: "text" as const, text: manifest.error.message }] };
        const file = findVideoFile(manifest.value.files);
        if (!file) return { isError: true as const, content: [{ type: "text" as const, text: `No video file found in asset ${assetId}` }] };
        videoInputs.push({ assetId, filename: file.name });
      }

      const baseName = prompt ? slugify(prompt) : imageInputs[0].assetId.replace(/^img-/, "");
      const videoName = `${modelSlug("kie", "kling-3.0/motion-control")}-${baseName || Date.now()}`;
      const assetResult = await fs.createAsset("vid", videoName, project_slug);
      if (!assetResult.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };
      }

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceImageIds = imageInputs.map((i) => i.assetId);
      const sourceVideoIds = videoInputs.map((i) => i.assetId);

      const jobId = `${modelSlug("kie", "kling-3.0/motion-control")}-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_kling30_motion_control_video",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        imageInputs,
        videoInputs,
        sourceImageIds,
        sourceVideoIds,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(character_orientation !== undefined ? { character_orientation } : {}),
        ...(background_source !== undefined ? { background_source } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            vid_asset_id: vidAssetId,
            source_images: sourceImageIds,
            source_videos: sourceVideoIds,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}

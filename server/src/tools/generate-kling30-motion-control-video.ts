import type { Engine, ArtifactManifestFile } from "videobook-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { KlingMotionControlRequestSchema } from "@apicity/kie/zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import { findVideoFile } from "videobook-engine";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";
import { assertKlingMotionControlDuration } from "../kling-motion-control-duration.js";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

function getImagesFromManifest(files: ArtifactManifestFile[]): ArtifactManifestFile[] {
  return files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
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
  book_id: z.string().describe("Project slug"),
  prompt: apicityStringField(motionControlInput.prompt, "Optional motion description"),
  character_image_slugs: apicityStringArrayField(motionControlInput.input_urls, "Character image @slugs (input_urls)", { required: true }),
  motion_video_slugs: apicityStringArrayField(motionControlInput.video_urls, "Motion reference video @slugs (video_urls)", { required: true }).max(1),
  mode: apicityField(motionControlInput.mode, "Output resolution: 720p / 1080p (default 720p)"),
  character_orientation: apicityField(motionControlInput.character_orientation, "Character orientation source: video / image (default video)"),
  background_source: apicityField(motionControlInput.background_source, "Background source: input_video / input_image (default input_video)"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateKling30MotionControlVideoSchema>;

export function generateKling30MotionControlVideoDef(fs: Engine): ToolDef {
  return {
    name: "generate_kie_kling_3_0_motion_control",
    description: "Apply motion from reference videos to character images using Kling 3.0 motion-control. Creates a new vid- asset and enqueues a background job.",
    schema: generateKling30MotionControlVideoSchema,
    handler: async (args) => {
      const {
        book_id, prompt,
        character_image_slugs, motion_video_slugs,
        mode, character_orientation, background_source,
      } = args as Args;

      const imageInputs: RefInput[] = [];
      for (const raw of character_image_slugs) {
        const assetId = raw.replace(/^@/, "");
        if (!assetId.startsWith("img-") && !assetId.startsWith("char-")) {
          return { isError: true as const, content: [{ type: "text" as const, text: `character_image_slugs entries must be img-* or char-* assets, got: ${assetId}` }] };
        }
        const manifest = await fs.files.manifest(assetId);
        if (!manifest.ok) return { isError: true as const, content: [{ type: "text" as const, text: manifest.error.message }] };
        const images = getImagesFromManifest(manifest.value.files);
        if (images.length === 0) return { isError: true as const, content: [{ type: "text" as const, text: `No image file found in asset ${assetId}` }] };
        
        imageInputs.push({ assetId, filename: images[0].name });
        if (assetId.startsWith("char-") && images.length > 1) {
          imageInputs.push({ assetId, filename: images[1].name });
        }
      }

      const videoInputs: RefInput[] = [];
      for (const raw of motion_video_slugs) {
        const assetId = raw.replace(/^@/, "");
        if (!assetId.startsWith("vid-")) {
          return { isError: true as const, content: [{ type: "text" as const, text: `motion_video_slugs entries must be vid-* assets, got: ${assetId}` }] };
        }
        const manifest = await fs.files.manifest(assetId);
        if (!manifest.ok) return { isError: true as const, content: [{ type: "text" as const, text: manifest.error.message }] };
        const file = findVideoFile(manifest.value.files);
        if (!file) return { isError: true as const, content: [{ type: "text" as const, text: `No video file found in asset ${assetId}` }] };
        videoInputs.push({ assetId, filename: file.name });
      }

      try {
        await assertKlingMotionControlDuration(
          fs,
          motion_video_slugs[0],
          character_orientation === "image" ? "image" : "video",
        );
      } catch (cause) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: cause instanceof Error ? cause.message : String(cause),
          }],
        };
      }

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      const baseName = prompt ? slugify(prompt) : imageInputs[0].assetId.replace(/^img-/, "");
      const videoName = `${modelSlug("kie", "kling-3.0/motion-control")}-${baseName || Date.now()}`;
      const assetResult = await fs.artifacts.create("vid", videoName);
      if (!assetResult.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };
      }

      const { slug: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceImageIds = imageInputs.map((i) => i.assetId);
      const sourceVideoIds = videoInputs.map((i) => i.assetId);

      const jobId = `${modelSlug("kie", "kling-3.0/motion-control")}-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_kling30_motion_control_video",
        vidAssetId,
        vidAssetDir,
        bookId: book_id,
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

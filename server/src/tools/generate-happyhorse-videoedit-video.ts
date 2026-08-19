import type { Engine, ArtifactManifestFile } from "videobook-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { HappyHorseVideoEditRequestSchema } from "@apicity/kie/zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import { findVideoFile } from "videobook-engine";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";
import { generationLabel } from "../artifact-label.js";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);
const happyHorseVideoEdit = HappyHorseVideoEditRequestSchema.shape.input.shape;

function findImageFile(files: ArtifactManifestFile[]): ArtifactManifestFile | null {
  const images = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
  return images.find((f) => f.name.startsWith("original")) ?? images[0] ?? null;
}

type RefInput = { assetId: string; filename: string };

const generateHappyhorseVideoeditVideoSchema = {
  book_id: z.string().describe("Book id"),
  video_ref: apicityStringField(happyHorseVideoEdit.video_url, "Source video artifact id to edit (3-60s)", { required: true }),
  prompt: apicityStringField(happyHorseVideoEdit.prompt, "Edit instruction (max 5000 chars / 2500 Chinese chars)", { required: true }),
  image_refs: apicityStringArrayField(happyHorseVideoEdit.reference_image, "0-5 optional reference images for character/style guidance"),
  resolution: apicityField(happyHorseVideoEdit.resolution, "Output resolution: 720p / 1080p (default 1080p)"),
  audio_setting: apicityField(happyHorseVideoEdit.audio_setting, "Audio: auto (model decides) or origin (keep original, default auto)"),
  seed: apicityField(happyHorseVideoEdit.seed, "Random seed for reproducibility"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateHappyhorseVideoeditVideoSchema>;

export function generateHappyhorseVideoeditVideoDef(engine: Engine): ToolDef {
  return {
    name: "generate_kie_happyhorse_1_1_edit_video",
    description: "Edit a source video using HappyHorse video-edit with optional reference images for character/style. Creates a new video artifact and enqueues a background job.",
    schema: generateHappyhorseVideoeditVideoSchema,
    handler: async (args) => {
      const { book_id, video_ref, prompt, image_refs, resolution, audio_setting, seed } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }] };
      }

      const videoAssetId = video_ref.replace(/^@/, "");
      const videoArtifact = engine.artifacts.get(videoAssetId);
      if (!videoArtifact.ok) return { isError: true as const, content: [{ type: "text" as const, text: videoArtifact.error.message }] };
      if (videoArtifact.value.kind !== "video") {
        return { isError: true as const, content: [{ type: "text" as const, text: `video_ref must be a video artifact, got ${videoArtifact.value.kind}: ${videoAssetId}` }] };
      }
      const videoManifest = await engine.files.manifest(videoAssetId);
      if (!videoManifest.ok) return { isError: true as const, content: [{ type: "text" as const, text: videoManifest.error.message }] };
      const videoFile = findVideoFile(videoManifest.value.files);
      if (!videoFile) return { isError: true as const, content: [{ type: "text" as const, text: `No video file found in asset ${videoAssetId}` }] };

      const imageInputs: RefInput[] = [];
      for (const raw of image_refs ?? []) {
        const assetId = raw.replace(/^@/, "");
        const artifact = engine.artifacts.get(assetId);
        if (!artifact.ok) return { isError: true as const, content: [{ type: "text" as const, text: artifact.error.message }] };
        if (artifact.value.kind !== "image") {
          return { isError: true as const, content: [{ type: "text" as const, text: `image_refs entries must be image artifacts, got ${artifact.value.kind}: ${assetId}` }] };
        }
        const manifest = await engine.files.manifest(assetId);
        if (!manifest.ok) return { isError: true as const, content: [{ type: "text" as const, text: manifest.error.message }] };
        const file = findImageFile(manifest.value.files);
        if (!file) return { isError: true as const, content: [{ type: "text" as const, text: `No image file found in asset ${assetId}` }] };
        imageInputs.push({ assetId, filename: file.name });
      }

      const videoName = generationLabel(modelSlug("kie", "happyhorse/video-edit"), prompt);
      const assetResult = await engine.artifacts.create("vid", videoName);
      if (!assetResult.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };
      }

      const { artifactId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceVideoIds = [videoAssetId];
      const sourceImageIds = imageInputs.map((i) => i.assetId);
      const jobId = `${modelSlug("kie", "happyhorse/video-edit")}-edit-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_happyhorse_videoedit_video",
        vidAssetId,
        vidAssetDir,
        bookId: book_id,
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

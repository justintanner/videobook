import type { ArtifactKind, Engine, ArtifactManifestFile } from "videobook-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { KlingMotionControlRequestSchema } from "@apicity/kie/zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import { findVideoFile } from "videobook-engine";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";
import { artifactKindOf, requireArtifactKind } from "./_shared.js";
import { assertKlingMotionControlDuration } from "../kling-motion-control-duration.js";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

function getImagesFromManifest(files: ArtifactManifestFile[]): ArtifactManifestFile[] {
  return files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
}

type ImageOrientation = "landscape" | "portrait" | "square";

export function selectMotionControlImageFiles(
  kind: ArtifactKind,
  files: ArtifactManifestFile[],
  preferredOrientation?: ImageOrientation,
): ArtifactManifestFile[] {
  const images = getImagesFromManifest(files);
  if (kind === "character") return images.slice(0, 2);
  const original = images.find((file) => /^original\.[^/]+$/i.test(file.name));
  const matching = preferredOrientation
    ? images.find((file) => file.name.toLowerCase() === `${preferredOrientation}.jpg`)
    : undefined;
  const selected = original ?? matching;
  return selected ? [selected] : [];
}

function imageOrientation(width: unknown, height: unknown): ImageOrientation | undefined {
  if (typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0) {
    return undefined;
  }
  if (width === height) return "square";
  return width > height ? "landscape" : "portrait";
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
  book_id: z.string().describe("Book id"),
  prompt: apicityStringField(motionControlInput.prompt, "Optional motion description"),
  character_image_refs: apicityStringArrayField(motionControlInput.input_urls, "Character image artifact ids (input_urls)", { required: true }),
  motion_video_refs: apicityStringArrayField(motionControlInput.video_urls, "Motion reference video artifact ids (video_urls)", { required: true }).max(1),
  mode: apicityField(motionControlInput.mode, "Output resolution: 720p / 1080p (default 720p)"),
  character_orientation: apicityField(motionControlInput.character_orientation, "Character orientation source: video / image (default video)"),
  background_source: apicityField(motionControlInput.background_source, "Background source: input_video / input_image (default input_video)"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateKling30MotionControlVideoSchema>;

export function generateKling30MotionControlVideoDef(fs: Engine): ToolDef {
  return {
    name: "generate_kie_kling_3_0_motion_control",
    description: "Apply motion from reference videos to character images using Kling 3.0 motion-control. Creates a new video artifact and enqueues a background job.",
    schema: generateKling30MotionControlVideoSchema,
    handler: async (args) => {
      const {
        book_id, prompt,
        character_image_refs, motion_video_refs,
        mode, character_orientation, background_source,
      } = args as Args;

      const videoInputs: RefInput[] = [];
      let preferredImageOrientation: ImageOrientation | undefined;
      for (const raw of motion_video_refs) {
        const assetId = raw.replace(/^@/, "");
        const kindGate = await requireArtifactKind(fs, assetId, ["video"], "motion_video_refs");
        if (kindGate) return kindGate;
        const [manifest, metadata] = await Promise.all([
          fs.files.manifest(assetId),
          fs.metadata.artifacts.read<Record<string, unknown>>(assetId, "original"),
        ]);
        if (!manifest.ok) return { isError: true as const, content: [{ type: "text" as const, text: manifest.error.message }] };
        const file = findVideoFile(manifest.value.files);
        if (!file) return { isError: true as const, content: [{ type: "text" as const, text: `No video file found in asset ${assetId}` }] };
        videoInputs.push({ assetId, filename: file.name });
        if (!preferredImageOrientation && metadata.ok) {
          preferredImageOrientation = imageOrientation(metadata.value.width, metadata.value.height);
        }
      }

      const imageInputs: RefInput[] = [];
      for (const raw of character_image_refs) {
        const assetId = raw.replace(/^@/, "");
        const kind = artifactKindOf(fs, assetId);
        if (kind !== "image" && kind !== "character") {
          return { isError: true as const, content: [{ type: "text" as const, text: `character_image_refs entries must be image or character artifacts; ${assetId} is ${kind ?? "not a known artifact"}` }] };
        }
        const manifest = await fs.files.manifest(assetId);
        if (!manifest.ok) return { isError: true as const, content: [{ type: "text" as const, text: manifest.error.message }] };
        const images = selectMotionControlImageFiles(
          kind,
          manifest.value.files,
          preferredImageOrientation,
        );
        if (images.length === 0) return { isError: true as const, content: [{ type: "text" as const, text: `No image file found in asset ${assetId}` }] };
        imageInputs.push(...images.map((image) => ({ assetId, filename: image.name })));
      }

      try {
        await assertKlingMotionControlDuration(
          fs,
          motion_video_refs[0],
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

      const firstImageArtifact = fs.artifacts.get(imageInputs[0].assetId);
      const firstImageLabel = firstImageArtifact.ok ? firstImageArtifact.value.label ?? "" : "";
      const baseName = prompt ? slugify(prompt) : slugify(firstImageLabel);
      const videoName = `${modelSlug("kie", "kling-3.0/motion-control")}-${baseName || Date.now()}`;
      const assetResult = await fs.artifacts.create("vid", videoName);
      if (!assetResult.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };
      }

      const { artifactId: vidAssetId, path: vidAssetDir } = assetResult.value;
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

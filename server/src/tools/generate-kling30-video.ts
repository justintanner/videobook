import type { Engine, ArtifactManifestFile } from "videobook-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { KlingVideoRequestSchema, MultiShotPromptSchema } from "@apicity/kie/zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import { findVideoFile } from "videobook-engine";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";
import { artifactKindOf, requireArtifactKind } from "./_shared.js";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

function findImageFile(files: ArtifactManifestFile[]): ArtifactManifestFile | null {
  const images = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
  return images.find((f) => f.name.startsWith("original")) ?? images[0] ?? null;
}

function findMediaFile(files: ArtifactManifestFile[], assetType: "image" | "video"): ArtifactManifestFile | null {
  if (assetType === "video") return findVideoFile(files);
  return findImageFile(files);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30)
    .replace(/-$/, "");
}

type ImageInput = { assetId: string; filename: string };
type ElementInput = {
  inputs: ImageInput[];
  name: string;
  desc: string;
  hasVideo: boolean;
};
const klingVideo = KlingVideoRequestSchema.shape.input.shape;
const multiShotPrompt = MultiShotPromptSchema.shape;

const generateKling30VideoSchema = {
  book_id: z.string().describe("Book id"),
  prompt: apicityStringField(klingVideo.prompt, "Video description"),
  image_refs: apicityStringArrayField(klingVideo.image_urls, "0-2 reference image artifact ids"),
  mode: apicityField(klingVideo.mode, "Resolution mode: std (standard) / pro (professional) / 4K", { required: true }),
  duration: apicityField(klingVideo.duration, "Video duration: 3s-15s", { required: true }),
  sound: apicityField(klingVideo.sound, "Generate audio for the video (optional; Kie defaults contextually under multi-shot)"),
  aspect_ratio: apicityField(klingVideo.aspect_ratio, "Video aspect ratio"),
  multi_shots: apicityField(klingVideo.multi_shots, "Enable multi-shot mode", { required: true }),
  multi_prompt: z.array(z.object({
    prompt: apicityStringField(multiShotPrompt.prompt, undefined, { required: true }),
    duration: apicityField(multiShotPrompt.duration, undefined, { required: true }),
  })).optional().describe("Scene list for multi-shot mode"),
  element1_refs: z.array(z.string()).optional().describe("1-4 image artifact ids or 1 video artifact id for element 1"),
  element1_name: z.string().optional().describe("Name for element 1"),
  element1_desc: z.string().optional().describe("Description for element 1"),
  element2_refs: z.array(z.string()).optional().describe("1-4 image artifact ids or 1 video artifact id for element 2"),
  element2_name: z.string().optional().describe("Name for element 2"),
  element2_desc: z.string().optional().describe("Description for element 2"),
  element3_refs: z.array(z.string()).optional().describe("1-4 image artifact ids or 1 video artifact id for element 3"),
  element3_name: z.string().optional().describe("Name for element 3"),
  element3_desc: z.string().optional().describe("Description for element 3"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie', 'xai')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateKling30VideoSchema>;

export function generateKling30VideoDef(fs: Engine): ToolDef {
  return {
    name: "generate_kie_kling_3_0_video",
    description: "Generate a video using Kling 3.0 with optional reference images, character elements, and multi-shot mode. Creates a new video artifact and enqueues a background job.",
    schema: generateKling30VideoSchema,
    handler: async (args) => {
      const {
        book_id, prompt, image_refs, mode, duration, sound,
        aspect_ratio, multi_shots, multi_prompt,
        element1_refs, element1_name, element1_desc,
        element2_refs, element2_name, element2_desc,
        element3_refs, element3_name, element3_desc,
      } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      // Resolve reference images
      const imageInputs: ImageInput[] = [];
      const sourceImageIds: string[] = [];
      const slugs = (image_refs ?? []).map((s) => s.replace(/^@/, ""));

      for (const assetId of slugs) {
        const kindGate = await requireArtifactKind(fs, assetId, ["image"], "image_refs");
        if (kindGate) return kindGate;
        const manifestResult = await fs.files.manifest(assetId);
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
        imageInputs.push({ assetId, filename: imageFile.name });
        sourceImageIds.push(assetId);
      }

      // Resolve element slugs
      const elementSlotDefs = [
        { slugs: element1_refs, name: element1_name, desc: element1_desc },
        { slugs: element2_refs, name: element2_name, desc: element2_desc },
        { slugs: element3_refs, name: element3_name, desc: element3_desc },
      ];

      const elementInputs: ElementInput[] = [];
      for (const slot of elementSlotDefs) {
        const rawSlugs = slot.slugs ?? [];
        if (rawSlugs.length === 0 && !slot.name && !slot.desc) continue;

        const inputs: ImageInput[] = [];
        let hasVideo = false;
        for (const raw of rawSlugs) {
          const assetId = raw.replace(/^@/, "");
          const kind = artifactKindOf(fs, assetId);
          const isVideo = kind === "video";
          const isImage = kind === "image";
          if (!isVideo && !isImage) {
            return {
              isError: true as const,
              content: [{ type: "text" as const, text: `Element refs must be image or video artifacts; ${assetId} is ${kind ?? "not a known artifact"}` }],
            };
          }
          if (isVideo) hasVideo = true;

          const manifestResult = await fs.files.manifest(assetId);
          if (!manifestResult.ok) {
            return {
              isError: true as const,
              content: [{ type: "text" as const, text: manifestResult.error.message }],
            };
          }
          const mediaFile = findMediaFile(manifestResult.value.files, isVideo ? "video" : "image");
          if (!mediaFile) {
            return {
              isError: true as const,
              content: [{ type: "text" as const, text: `No media file found in asset ${assetId}` }],
            };
          }
          inputs.push({ assetId, filename: mediaFile.name });
        }

        elementInputs.push({
          inputs,
          name: slot.name ?? "",
          desc: slot.desc ?? "",
          hasVideo,
        });
      }

      // Create output video asset
      const videoName = prompt ? `${modelSlug("kie", "kling-3.0/video")}-${slugify(prompt)}` : `${modelSlug("kie", "kling-3.0/video")}-${Date.now()}`;
      const assetResult = await fs.artifacts.create("vid", videoName);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }],
        };
      }

      const { artifactId: vidAssetId, path: vidAssetDir } = assetResult.value;

      const jobId = `${modelSlug("kie", "kling-3.0/video")}-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_kling30_video",
        imageInputs,
        elementInputs,
        sourceImageIds,
        vidAssetId,
        vidAssetDir,
        bookId: book_id,
        ...(prompt !== undefined ? { prompt } : {}),
        mode,
        duration,
        sound,
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        multi_shots,
        ...(multi_prompt !== undefined && multi_prompt.length > 0 ? { multi_prompt } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            vid_asset_id: vidAssetId,
            source_images: sourceImageIds,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}

import type { ClipfirstFs, AssetManifestFile } from "clipfirst-engine";
import { z, type ZodRawShape } from "zod";
import { KlingAspectRatioSchema, KlingDurationSchema, KlingModeSchema } from "@apicity/kie/zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import { findVideoFile } from "clipfirst-engine";
import { QUEUED_TASK_ID } from "clipfirst-engine";
import type { SchemaArgs, ToolDef } from "./tool-def.js";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

function findImageFile(files: AssetManifestFile[]): AssetManifestFile | null {
  const images = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
  return images.find((f) => f.name.startsWith("original")) ?? images[0] ?? null;
}

function findMediaFile(files: AssetManifestFile[], assetType: "image" | "video"): AssetManifestFile | null {
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

const generateKling30VideoSchema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().optional().describe("Video description"),
  image_slugs: z.array(z.string()).optional().describe("0-2 reference image @slugs (e.g., @img-sunset)"),
  mode: z.enum(KlingModeSchema.options).optional().describe("Resolution mode: std (standard) / pro (professional)"),
  duration: z.enum(KlingDurationSchema.options).optional().describe("Video duration: 3s-15s"),
  sound: z.boolean().optional().describe("Generate audio for the video (default: true)"),
  aspect_ratio: z.enum(KlingAspectRatioSchema.options).optional().describe("Video aspect ratio"),
  multi_shots: z.boolean().optional().describe("Enable multi-shot mode"),
  multi_prompt: z.array(z.object({
    prompt: z.string(),
    duration: z.number(),
  })).optional().describe("Scene list for multi-shot mode"),
  element1_slugs: z.array(z.string()).optional().describe("1-4 image @slugs or 1 video @slug for element 1"),
  element1_name: z.string().optional().describe("Name for element 1"),
  element1_desc: z.string().optional().describe("Description for element 1"),
  element2_slugs: z.array(z.string()).optional().describe("1-4 image @slugs or 1 video @slug for element 2"),
  element2_name: z.string().optional().describe("Name for element 2"),
  element2_desc: z.string().optional().describe("Description for element 2"),
  element3_slugs: z.array(z.string()).optional().describe("1-4 image @slugs or 1 video @slug for element 3"),
  element3_name: z.string().optional().describe("Name for element 3"),
  element3_desc: z.string().optional().describe("Description for element 3"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie', 'xai')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateKling30VideoSchema>;

export function generateKling30VideoDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_kling30_video",
    description: "Generate a video using Kling 3.0 with optional reference images, character elements, and multi-shot mode. Creates a new vid- asset and enqueues a background job.",
    schema: generateKling30VideoSchema,
    handler: async (args) => {
      const {
        project_slug, prompt, image_slugs, mode, duration, sound,
        aspect_ratio, multi_shots, multi_prompt,
        element1_slugs, element1_name, element1_desc,
        element2_slugs, element2_name, element2_desc,
        element3_slugs, element3_name, element3_desc,
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
      const slugs = (image_slugs ?? []).map((s) => s.replace(/^@/, ""));

      for (const assetId of slugs) {
        if (!assetId.startsWith("img-")) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `image_slugs entries must be img-* assets, got: ${assetId}` }],
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
        imageInputs.push({ assetId, filename: imageFile.name });
        sourceImageIds.push(assetId);
      }

      // Resolve element slugs
      const elementSlotDefs = [
        { slugs: element1_slugs, name: element1_name, desc: element1_desc },
        { slugs: element2_slugs, name: element2_name, desc: element2_desc },
        { slugs: element3_slugs, name: element3_name, desc: element3_desc },
      ];

      const elementInputs: ElementInput[] = [];
      for (const slot of elementSlotDefs) {
        const rawSlugs = slot.slugs ?? [];
        if (rawSlugs.length === 0 && !slot.name && !slot.desc) continue;

        const inputs: ImageInput[] = [];
        let hasVideo = false;
        for (const raw of rawSlugs) {
          const assetId = raw.replace(/^@/, "");
          const isVideo = assetId.startsWith("vid-");
          const isImage = assetId.startsWith("img-");
          if (!isVideo && !isImage) {
            return {
              isError: true as const,
              content: [{ type: "text" as const, text: `Element slugs must be img-* or vid-* assets, got: ${assetId}` }],
            };
          }
          if (isVideo) hasVideo = true;

          const manifestResult = await fs.getManifest(assetId, project_slug);
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
      const videoName = prompt ? `kling-${slugify(prompt)}` : `kling-${Date.now()}`;
      const assetResult = await fs.createAsset("vid", videoName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;

      {
        const _ptResult = await fs.pendingTasks.write(project_slug, {
          taskId: QUEUED_TASK_ID,
          taskType: "kling30_video",
          assetId: vidAssetId,
          assetDir: vidAssetDir,
          meta: { sourceImageIds, ...(prompt !== undefined ? { prompt } : {}) },
        });
        if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${vidAssetId}: ${_ptResult.error.message}`);
      }

      const jobId = `kling30-video-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_kling30_video",
        imageInputs,
        elementInputs,
        sourceImageIds,
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(sound !== undefined ? { sound } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(multi_shots !== undefined ? { multi_shots } : {}),
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

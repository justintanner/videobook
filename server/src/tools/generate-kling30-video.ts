import type { ClipfirstFs, AssetManifestFile } from "clipfirst-fs";
import { z } from "zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import { findVideoFile } from "../media-files.js";
import type { ToolDef } from "./tool-def.js";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "avi", "mkv"]);

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

export function generateKling30VideoDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_kling30_video",
    description: "Generate a video using Kling 3.0 with optional reference images, character elements, and multi-shot mode. Creates a new vid- asset and enqueues a background job.",
    schema: {
      project_slug: z.string().describe("Project slug"),
      prompt: z.string().optional().describe("Video description"),
      image_slugs: z.array(z.string()).optional().describe("0-2 reference image @slugs (e.g., @img-sunset)"),
      mode: z.enum(["std", "pro"]).optional().describe("Resolution mode: std (standard) / pro (professional)"),
      duration: z.string().optional().describe("Video duration: 3s-15s"),
      sound: z.boolean().optional().describe("Generate audio for the video (default: true)"),
      aspect_ratio: z.enum(["16:9", "9:16", "1:1"]).optional().describe("Video aspect ratio"),
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
      image_orientation: z.enum(["auto", "original", "portrait", "landscape"]).optional().describe("Override which input image variant to select"),
    },
    handler: async (args) => {
      const {
        project_slug, prompt, image_slugs, mode, duration, sound,
        aspect_ratio, multi_shots, multi_prompt,
        element1_slugs, element1_name, element1_desc,
        element2_slugs, element2_name, element2_desc,
        element3_slugs, element3_name, element3_desc,
      } = args as {
        project_slug: string;
        prompt?: string;
        image_slugs?: string[];
        mode?: "std" | "pro";
        duration?: string;
        sound?: boolean;
        aspect_ratio?: "16:9" | "9:16" | "1:1";
        multi_shots?: boolean;
        multi_prompt?: Array<{ prompt: string; duration: number }>;
        element1_slugs?: string[];
        element1_name?: string;
        element1_desc?: string;
        element2_slugs?: string[];
        element2_name?: string;
        element2_desc?: string;
        element3_slugs?: string[];
        element3_name?: string;
        element3_desc?: string;
      };

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

import type { ClipfirstFs, AssetManifestFile } from "clipfirst-fs";
import { z, type ZodRawShape } from "zod";
import { Wan27AspectRatioSchema, Wan27AudioSettingSchema, Wan27ResolutionSchema } from "@apicity/kie/zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import { findVideoFile } from "../media-files.js";
import { writePendingTask, QUEUED_TASK_ID } from "../jobs/pending-task.js";
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
type ResolveOk = { ok: true; value: RefInput };
type ResolveErr = { ok: false; error: string };

async function resolveVideoSlug(fs: ClipfirstFs, raw: string, projectSlug: string): Promise<ResolveOk | ResolveErr> {
  const assetId = raw.replace(/^@/, "");
  if (!assetId.startsWith("vid-")) return { ok: false, error: `video_slug must be a vid-* asset, got: ${assetId}` };
  const manifest = await fs.getManifest(assetId, projectSlug);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findVideoFile(manifest.value.files);
  if (!file) return { ok: false, error: `No video file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

async function resolveImageSlug(fs: ClipfirstFs, raw: string, projectSlug: string): Promise<ResolveOk | ResolveErr> {
  const assetId = raw.replace(/^@/, "");
  if (!assetId.startsWith("img-")) return { ok: false, error: `image_slug must be an img-* asset, got: ${assetId}` };
  const manifest = await fs.getManifest(assetId, projectSlug);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findImageFile(manifest.value.files);
  if (!file) return { ok: false, error: `No image file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

const generateWan27VideoeditVideoSchema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().optional().describe("Edit description (max 5000 chars)"),
  negative_prompt: z.string().optional().describe("Negative prompt — things to avoid (max 500 chars)"),
  video_slug: z.string().describe("Source video asset to edit (e.g., @vid-scene)"),
  image_slug: z.string().optional().describe("Reference image for character/style guidance (e.g., @img-outfit)"),
  resolution: z.enum(Wan27ResolutionSchema.options).optional().describe("Video resolution (default 1080p)"),
  aspect_ratio: z.enum(Wan27AspectRatioSchema.options).optional().describe("Video aspect ratio (omit to match source)"),
  duration: z.string().optional().describe("Video duration in seconds (0=full source, or 2-10)"),
  audio_setting: z.enum(Wan27AudioSettingSchema.options).optional().describe("Audio: auto (model decides) or origin (keep original)"),
  prompt_extend: z.boolean().optional().describe("Intelligent prompt rewriting (default true)"),
  watermark: z.boolean().optional().describe("Add 'AI generated' watermark (default false)"),
  nsfw_checker: z.boolean().optional().describe("Content safety filter (default false)"),
  seed: z.number().int().optional().describe("Random seed for reproducibility"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateWan27VideoeditVideoSchema>;

export function generateWan27VideoeditVideoDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_wan27_videoedit_video",
    description: "Edit a video using Wan 2.7 Video Edit with optional reference image for character, clothing, or style guidance. Creates a new vid- asset and enqueues a background job.",
    schema: generateWan27VideoeditVideoSchema,
    handler: async (args) => {
      const {
        project_slug, prompt, negative_prompt,
        video_slug, image_slug,
        resolution, aspect_ratio, duration, audio_setting, prompt_extend, watermark, nsfw_checker, seed,
      } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      if (!video_slug) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "Wan 2.7 Video Edit requires video_slug" }],
        };
      }

      const videoResult = await resolveVideoSlug(fs, video_slug, project_slug);
      if (!videoResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: videoResult.error }] };
      const videoInput = videoResult.value;

      const MAX_INPUT_DURATION = 10;
      const meta = await fs.readMetadata<{ duration?: number }>(videoInput.assetId, "original", project_slug);
      if (meta.ok && typeof meta.value.duration === "number" && meta.value.duration > MAX_INPUT_DURATION) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Source video is ${meta.value.duration.toFixed(1)}s — Wan 2.7 Video Edit accepts at most ${MAX_INPUT_DURATION}s. Trim the video first.` }],
        };
      }

      let imageInput: RefInput | undefined;
      if (image_slug) {
        const r = await resolveImageSlug(fs, image_slug, project_slug);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        imageInput = r.value;
      }

      const videoName = `wan27-edit-${slugify(prompt ?? "") || String(Date.now())}`;
      const assetResult = await fs.createAsset("vid", videoName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceImageIds = imageInput ? [imageInput.assetId] : [];
      const sourceVideoIds = [videoInput.assetId];
      const sourceAudioIds: string[] = [];

      await writePendingTask(fs, vidAssetId, project_slug, {
        taskId: QUEUED_TASK_ID,
        taskType: "wan27_videoedit_video",
        assetId: vidAssetId,
        assetDir: vidAssetDir,
        projectSlug: project_slug,
        createdAt: new Date().toISOString(),
        meta: {
          prompt: prompt ?? "",
          mode: "videoedit",
          sourceImageIds,
          sourceVideoIds,
          sourceAudioIds,
        },
      });

      const jobId = `wan27-videoedit-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_wan27_videoedit_video",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(negative_prompt !== undefined ? { negative_prompt } : {}),
        videoInput,
        ...(imageInput ? { imageInput } : {}),
        sourceImageIds,
        sourceVideoIds,
        sourceAudioIds,
        ...(resolution !== undefined ? { resolution } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(audio_setting !== undefined ? { audio_setting } : {}),
        ...(prompt_extend !== undefined ? { prompt_extend } : {}),
        ...(watermark !== undefined ? { watermark } : {}),
        ...(nsfw_checker !== undefined ? { nsfw_checker } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            vid_asset_id: vidAssetId,
            source_images: sourceImageIds,
            source_videos: sourceVideoIds,
            source_audios: sourceAudioIds,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}

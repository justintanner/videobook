import type { ClipfirstFs, AssetManifestFile } from "clipfirst-fs";
import { z } from "zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import { findAudioFile, findVideoFile } from "../media-files.js";
import { writePendingTask, QUEUED_TASK_ID } from "../jobs/pending-task.js";
import type { ToolDef } from "./tool-def.js";

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

async function resolveImageSlug(fs: ClipfirstFs, raw: string, projectSlug: string): Promise<ResolveOk | ResolveErr> {
  const assetId = raw.replace(/^@/, "");
  if (!assetId.startsWith("img-")) return { ok: false, error: `Frame slugs must be img-* assets, got: ${assetId}` };
  const manifest = await fs.getManifest(assetId, projectSlug);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findImageFile(manifest.value.files);
  if (!file) return { ok: false, error: `No image file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

async function resolveVideoSlug(fs: ClipfirstFs, raw: string, projectSlug: string): Promise<ResolveOk | ResolveErr> {
  const assetId = raw.replace(/^@/, "");
  if (!assetId.startsWith("vid-")) return { ok: false, error: `first_clip_slug must be a vid-* asset, got: ${assetId}` };
  const manifest = await fs.getManifest(assetId, projectSlug);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findVideoFile(manifest.value.files);
  if (!file) return { ok: false, error: `No video file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

async function resolveAudioSlug(fs: ClipfirstFs, raw: string, projectSlug: string): Promise<ResolveOk | ResolveErr> {
  const assetId = raw.replace(/^@/, "");
  if (!assetId.startsWith("aud-")) return { ok: false, error: `driving_audio_slug must be an aud-* asset, got: ${assetId}` };
  const manifest = await fs.getManifest(assetId, projectSlug);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findAudioFile(manifest.value.files, assetId);
  if (!file) return { ok: false, error: `No audio file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

export function generateWan27I2vVideoDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_wan27_i2v_video",
    description: "Generate a video using Wan 2.7 Image to Video with first/last frame image control, clip continuation, or driving audio. Creates a new vid- asset and enqueues a background job.",
    schema: {
      project_slug: z.string().describe("Project slug"),
      prompt: z.string().describe("Video description (max 5000 chars)"),
      negative_prompt: z.string().optional().describe("Negative prompt — things to avoid (max 500 chars)"),
      first_frame_slug: z.string().optional().describe("First frame image asset (e.g., @img-start)"),
      last_frame_slug: z.string().optional().describe("Last frame image asset (e.g., @img-end)"),
      first_clip_slug: z.string().optional().describe("Video asset for continuation (e.g., @vid-scene)"),
      driving_audio_slug: z.string().optional().describe("Audio asset for audio-driven motion (e.g., @aud-music)"),
      resolution: z.enum(["720p", "1080p"]).optional().describe("Video resolution (default 1080p)"),
      duration: z.string().optional().describe("Video duration in seconds (2-15)"),
      prompt_extend: z.boolean().optional().describe("Intelligent prompt rewriting (default true)"),
      nsfw_checker: z.boolean().optional().describe("Content safety filter (default false)"),
      seed: z.number().int().optional().describe("Random seed for reproducibility"),
      image_orientation: z.enum(["auto", "original", "portrait", "landscape"]).optional().describe("Image orientation hint"),
      _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
    },
    handler: async (args) => {
      const {
        project_slug, prompt, negative_prompt,
        first_frame_slug, last_frame_slug, first_clip_slug, driving_audio_slug,
        resolution, duration, prompt_extend, nsfw_checker, seed,
      } = args as {
        project_slug: string;
        prompt: string;
        negative_prompt?: string;
        first_frame_slug?: string;
        last_frame_slug?: string;
        first_clip_slug?: string;
        driving_audio_slug?: string;
        resolution?: "720p" | "1080p";
        duration?: string;
        prompt_extend?: boolean;
        nsfw_checker?: boolean;
        seed?: number;
      };

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      if (!first_frame_slug && !last_frame_slug && !first_clip_slug) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "Wan 2.7 Image to Video requires at least first_frame_slug, last_frame_slug, or first_clip_slug" }],
        };
      }

      let firstFrame: RefInput | undefined;
      if (first_frame_slug) {
        const r = await resolveImageSlug(fs, first_frame_slug, project_slug);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        firstFrame = r.value;
      }

      let lastFrame: RefInput | undefined;
      if (last_frame_slug) {
        const r = await resolveImageSlug(fs, last_frame_slug, project_slug);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        lastFrame = r.value;
      }

      let firstClip: RefInput | undefined;
      if (first_clip_slug) {
        const r = await resolveVideoSlug(fs, first_clip_slug, project_slug);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        firstClip = r.value;
      }

      let drivingAudio: RefInput | undefined;
      if (driving_audio_slug) {
        const r = await resolveAudioSlug(fs, driving_audio_slug, project_slug);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        drivingAudio = r.value;
      }

      const videoName = `wan27-${slugify(prompt) || String(Date.now())}`;
      const assetResult = await fs.createAsset("vid", videoName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceImageIds = [firstFrame?.assetId, lastFrame?.assetId].filter((v): v is string => v !== undefined);
      const sourceVideoIds = firstClip ? [firstClip.assetId] : [];
      const sourceAudioIds = drivingAudio ? [drivingAudio.assetId] : [];

      await writePendingTask(fs, vidAssetId, project_slug, {
        taskId: QUEUED_TASK_ID,
        taskType: "wan27_i2v_video",
        assetId: vidAssetId,
        assetDir: vidAssetDir,
        projectSlug: project_slug,
        createdAt: new Date().toISOString(),
        meta: {
          prompt,
          mode: "i2v",
          sourceImageIds,
          sourceVideoIds,
          sourceAudioIds,
        },
      });

      const jobId = `wan27-i2v-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_wan27_i2v_video",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        prompt,
        ...(negative_prompt !== undefined ? { negative_prompt } : {}),
        ...(firstFrame ? { firstFrame } : {}),
        ...(lastFrame ? { lastFrame } : {}),
        ...(firstClip ? { firstClip } : {}),
        ...(drivingAudio ? { drivingAudio } : {}),
        sourceImageIds,
        sourceVideoIds,
        sourceAudioIds,
        ...(resolution !== undefined ? { resolution } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(prompt_extend !== undefined ? { prompt_extend } : {}),
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

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
  if (!assetId.startsWith("img-")) return { ok: false, error: `image_slugs entries must be img-* assets, got: ${assetId}` };
  const manifest = await fs.getManifest(assetId, projectSlug);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findImageFile(manifest.value.files);
  if (!file) return { ok: false, error: `No image file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

async function resolveVideoSlug(fs: ClipfirstFs, raw: string, projectSlug: string): Promise<ResolveOk | ResolveErr> {
  const assetId = raw.replace(/^@/, "");
  if (!assetId.startsWith("vid-")) return { ok: false, error: `video_slugs entries must be vid-* assets, got: ${assetId}` };
  const manifest = await fs.getManifest(assetId, projectSlug);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findVideoFile(manifest.value.files);
  if (!file) return { ok: false, error: `No video file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

async function resolveAudioSlug(fs: ClipfirstFs, raw: string, projectSlug: string): Promise<ResolveOk | ResolveErr> {
  const assetId = raw.replace(/^@/, "");
  if (!assetId.startsWith("aud-")) return { ok: false, error: `audio_slug must be an aud-* asset, got: ${assetId}` };
  const manifest = await fs.getManifest(assetId, projectSlug);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findAudioFile(manifest.value.files, assetId);
  if (!file) return { ok: false, error: `No audio file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

export function generateWan27ReferenceVideoDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_wan27_reference_video",
    description: "Generate a video using Wan 2.7 guided by reference images (0-5), videos (0-5), voice timbre, and optional first frame. Creates a new vid- asset and enqueues a background job.",
    schema: {
      project_slug: z.string().describe("Project slug"),
      prompt: z.string().describe("Video description (max 5000 chars)"),
      negative_prompt: z.string().optional().describe("Negative prompt — things to avoid (max 500 chars)"),
      image_slugs: z.array(z.string()).optional().describe("Reference image @slugs (max 5 combined with videos)"),
      video_slugs: z.array(z.string()).optional().describe("Reference video @slugs (max 5 combined with images)"),
      first_frame_slug: z.string().optional().describe("First frame image asset (overrides aspect_ratio, e.g., @img-start)"),
      audio_slug: z.string().optional().describe("Voice timbre audio asset (wav/mp3, 1-10s, e.g., @aud-voice)"),
      resolution: z.enum(["720p", "1080p"]).optional().describe("Video resolution (default 1080p)"),
      aspect_ratio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]).optional().describe("Video aspect ratio (ignored if first_frame_slug set)"),
      duration: z.string().optional().describe("Video duration in seconds (2-10)"),
      prompt_extend: z.boolean().optional().describe("Intelligent prompt rewriting (default true)"),
      seed: z.number().int().optional().describe("Random seed for reproducibility"),
      image_orientation: z.enum(["auto", "original", "portrait", "landscape"]).optional().describe("Image orientation hint"),
      _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
    },
    handler: async (args) => {
      const {
        project_slug, prompt, negative_prompt,
        image_slugs, video_slugs, first_frame_slug, audio_slug,
        resolution, aspect_ratio, duration, prompt_extend, seed,
      } = args as {
        project_slug: string;
        prompt: string;
        negative_prompt?: string;
        image_slugs?: string[];
        video_slugs?: string[];
        first_frame_slug?: string;
        audio_slug?: string;
        resolution?: "720p" | "1080p";
        aspect_ratio?: string;
        duration?: string;
        prompt_extend?: boolean;
        seed?: number;
      };

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      const imgs = image_slugs ?? [];
      const vids = video_slugs ?? [];
      const totalRefs = imgs.length + vids.length;

      if (totalRefs > 5) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Wan 2.7 Reference supports max 5 combined images+videos (got ${totalRefs})` }],
        };
      }

      const imageInputs: RefInput[] = [];
      for (const raw of imgs) {
        const r = await resolveImageSlug(fs, raw, project_slug);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        imageInputs.push(r.value);
      }

      const videoInputs: RefInput[] = [];
      for (const raw of vids) {
        const r = await resolveVideoSlug(fs, raw, project_slug);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        videoInputs.push(r.value);
      }

      let firstFrame: RefInput | undefined;
      if (first_frame_slug) {
        const r = await resolveImageSlug(fs, first_frame_slug, project_slug);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        firstFrame = r.value;
      }

      let voiceRef: RefInput | undefined;
      if (audio_slug) {
        const r = await resolveAudioSlug(fs, audio_slug, project_slug);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        voiceRef = r.value;
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
      const sourceImageIds = [...imageInputs.map((i) => i.assetId), ...(firstFrame ? [firstFrame.assetId] : [])];
      const sourceVideoIds = videoInputs.map((i) => i.assetId);
      const sourceAudioIds = voiceRef ? [voiceRef.assetId] : [];

      await writePendingTask(fs, vidAssetId, project_slug, {
        taskId: QUEUED_TASK_ID,
        taskType: "wan27_reference_video",
        assetId: vidAssetId,
        assetDir: vidAssetDir,
        projectSlug: project_slug,
        createdAt: new Date().toISOString(),
        meta: {
          prompt,
          mode: "reference",
          sourceImageIds,
          sourceVideoIds,
          sourceAudioIds,
        },
      });

      const jobId = `wan27-reference-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_wan27_reference_video",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        prompt,
        ...(negative_prompt !== undefined ? { negative_prompt } : {}),
        imageInputs,
        videoInputs,
        ...(firstFrame ? { firstFrame } : {}),
        ...(voiceRef ? { voiceRef } : {}),
        sourceImageIds,
        sourceVideoIds,
        sourceAudioIds,
        ...(resolution !== undefined ? { resolution } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(prompt_extend !== undefined ? { prompt_extend } : {}),
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

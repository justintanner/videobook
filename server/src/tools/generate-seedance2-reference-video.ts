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
  if (!assetId.startsWith("aud-")) return { ok: false, error: `audio_slugs entries must be aud-* assets, got: ${assetId}` };
  const manifest = await fs.getManifest(assetId, projectSlug);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findAudioFile(manifest.value.files, assetId);
  if (!file) return { ok: false, error: `No audio file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

export function generateSeedance2ReferenceVideoDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_seedance2_reference_video",
    description: "Generate a video using ByteDance Seedance 2.0 Fast guided by reference images (1-9), videos (0-3), and/or audio (0-3). Creates a new vid- asset and enqueues a background job.",
    schema: {
      project_slug: z.string().describe("Project slug"),
      prompt: z.string().describe("Video description (3-2500 characters)"),
      image_slugs: z.array(z.string()).optional().describe("1-9 reference image @slugs (e.g., @img-style)"),
      video_slugs: z.array(z.string()).optional().describe("0-3 reference video @slugs, total ≤15s (e.g., @vid-motion)"),
      audio_slugs: z.array(z.string()).optional().describe("0-3 reference audio @slugs, total ≤15s (e.g., @aud-music)"),
      aspect_ratio: z.enum(["1:1", "4:3", "3:4", "16:9", "9:16", "21:9", "adaptive"]).optional().describe("Output aspect ratio"),
      resolution: z.enum(["480p", "720p"]).optional().describe("Output resolution"),
      duration: z.string().optional().describe("Video duration in seconds (4-15)"),
      generate_audio: z.boolean().optional().describe("Generate accompanying audio (default true)"),
      return_last_frame: z.boolean().optional().describe("Return the final frame as an image (default false)"),
      web_search: z.boolean().optional().describe("Use web search for enhanced grounding (default false)"),
      _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
    },
    handler: async (args) => {
      const {
        project_slug, prompt,
        image_slugs, video_slugs, audio_slugs,
        aspect_ratio, resolution, duration,
        generate_audio, return_last_frame, web_search,
      } = args as {
        project_slug: string;
        prompt: string;
        image_slugs?: string[];
        video_slugs?: string[];
        audio_slugs?: string[];
        aspect_ratio?: string;
        resolution?: "480p" | "720p";
        duration?: string;
        generate_audio?: boolean;
        return_last_frame?: boolean;
        web_search?: boolean;
      };

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      const imgs = image_slugs ?? [];
      const vids = video_slugs ?? [];
      const auds = audio_slugs ?? [];

      if (imgs.length === 0 && vids.length === 0 && auds.length === 0) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "Seedance 2.0 Reference mode requires at least one reference asset (image, video, or audio)" }],
        };
      }
      if (imgs.length > 9) {
        return { isError: true as const, content: [{ type: "text" as const, text: `image_slugs supports up to 9 (got ${imgs.length})` }] };
      }
      if (vids.length > 3) {
        return { isError: true as const, content: [{ type: "text" as const, text: `video_slugs supports up to 3 (got ${vids.length})` }] };
      }
      if (auds.length > 3) {
        return { isError: true as const, content: [{ type: "text" as const, text: `audio_slugs supports up to 3 (got ${auds.length})` }] };
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

      const audioInputs: RefInput[] = [];
      for (const raw of auds) {
        const r = await resolveAudioSlug(fs, raw, project_slug);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        audioInputs.push(r.value);
      }

      const videoName = `seedance2-${slugify(prompt) || String(Date.now())}`;
      const assetResult = await fs.createAsset("vid", videoName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceImageIds = imageInputs.map((i) => i.assetId);
      const sourceVideoIds = videoInputs.map((i) => i.assetId);
      const sourceAudioIds = audioInputs.map((i) => i.assetId);

      await writePendingTask(fs, vidAssetId, project_slug, {
        taskId: QUEUED_TASK_ID,
        taskType: "seedance2_video",
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
          ...(return_last_frame !== undefined ? { return_last_frame } : {}),
        },
      });

      const jobId = `seedance2-reference-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_seedance2_reference_video",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        prompt,
        imageInputs,
        videoInputs,
        audioInputs,
        sourceImageIds,
        sourceVideoIds,
        sourceAudioIds,
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(generate_audio !== undefined ? { generate_audio } : {}),
        ...(return_last_frame !== undefined ? { return_last_frame } : {}),
        ...(web_search !== undefined ? { web_search } : {}),
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

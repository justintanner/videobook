import type { VideocityFs, AssetManifestFile } from "videocity-engine";
import { z, type ZodRawShape } from "zod";
import { AlibabaVideoSynthesisParametersSchema } from "@apicity/alibaba/zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import { findVideoFile, findAudioFile } from "videocity-engine";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { apicityField } from "./schema-from-apicity.js";

const ALIBABA_VIDEO_MODELS = ["wan2.7-i2v", "wan2.7-videoedit"] as const;
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

async function resolveImageSlug(fs: VideocityFs, raw: string, projectSlug: string): Promise<ResolveOk | ResolveErr> {
  const assetId = raw.replace(/^@/, "");
  if (!assetId.startsWith("img-")) return { ok: false, error: `Frame slugs must be img-* assets, got: ${assetId}` };
  const manifest = await fs.getManifest(assetId, projectSlug);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findImageFile(manifest.value.files);
  if (!file) return { ok: false, error: `No image file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

// `@<assetId>/<filename>` addresses a specific sibling file inside an asset
// (e.g. `@plan/s1.mp4`). Bypasses the prefix gate so plan-driven slugs work.
async function resolveSlashedSlug(
  fs: VideocityFs,
  raw: string,
  projectSlug: string,
): Promise<ResolveOk | ResolveErr | null> {
  const stripped = raw.replace(/^@/, "");
  const slashIdx = stripped.indexOf("/");
  if (slashIdx < 0) return null;
  const assetId = stripped.slice(0, slashIdx);
  const filename = stripped.slice(slashIdx + 1);
  if (!assetId || !filename) return { ok: false, error: `Invalid slashed slug: ${raw}` };
  const manifest = await fs.getManifest(assetId, projectSlug, { includeDotfiles: true });
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = manifest.value.files.find((f) => f.name === filename);
  if (!file) return { ok: false, error: `File ${filename} not found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename } };
}

async function resolveVideoSlug(fs: VideocityFs, raw: string, projectSlug: string): Promise<ResolveOk | ResolveErr> {
  const slashed = await resolveSlashedSlug(fs, raw, projectSlug);
  if (slashed !== null) return slashed;
  const assetId = raw.replace(/^@/, "");
  if (!assetId.startsWith("vid-")) return { ok: false, error: `Video slugs must be vid-* assets, got: ${assetId}` };
  const manifest = await fs.getManifest(assetId, projectSlug);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findVideoFile(manifest.value.files);
  if (!file) return { ok: false, error: `No video file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

async function resolveAudioSlug(fs: VideocityFs, raw: string, projectSlug: string): Promise<ResolveOk | ResolveErr> {
  const slashed = await resolveSlashedSlug(fs, raw, projectSlug);
  if (slashed !== null) return slashed;
  const assetId = raw.replace(/^@/, "");
  if (!assetId.startsWith("aud-")) return { ok: false, error: `Audio slugs must be aud-* assets, got: ${assetId}` };
  const manifest = await fs.getManifest(assetId, projectSlug);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findAudioFile(manifest.value.files, assetId);
  if (!file) return { ok: false, error: `No audio file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

const generateAlibabaVideoSchema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().describe("Video description"),
  negative_prompt: z.string().optional().describe("Negative prompt — things to avoid"),
  model: z.enum(ALIBABA_VIDEO_MODELS).describe("DashScope video model name ('wan2.7-i2v' or 'wan2.7-videoedit')"),
  first_frame_slug: z.string().optional().describe("First frame image asset (e.g., @img-start)"),
  last_frame_slug: z.string().optional().describe("Last frame image asset (e.g., @img-end)"),
  first_clip_slug: z.string().optional().describe("Video asset for clip continuation (e.g., @vid-scene)"),
  driving_audio_slug: z.string().optional().describe("Audio asset for audio-driven motion (e.g., @aud-music)"),
  video_slug: z.string().optional().describe("Reference video asset (e.g., @vid-ref)"),
  resolution: apicityField(AlibabaVideoSynthesisParametersSchema.shape.resolution, "Output resolution"),
  duration: z.number().int().optional().describe("Video duration in seconds (2-15)"),
  prompt_extend: z.boolean().optional().describe("Intelligent prompt rewriting"),
  watermark: z.boolean().optional().describe("Add watermark to output video"),
  audio_setting: apicityField(AlibabaVideoSynthesisParametersSchema.shape.audio_setting, "Driving-audio behavior: auto or origin"),
  seed: z.number().int().optional().describe("Random seed for reproducibility"),
  _provider: z.string().optional().describe("Provider key (e.g., 'alibaba')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateAlibabaVideoSchema>;

export function generateAlibabaVideoDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_alibaba_video",
    description: "Generate a video using Alibaba Cloud DashScope Video Synthesis. Requires at least one media input (first/last frame, reference video, driving audio, or clip continuation). Creates a new vid- asset and enqueues a background job.",
    schema: generateAlibabaVideoSchema,
    handler: async (args) => {
      const {
        project_slug, prompt, negative_prompt, model,
        first_frame_slug, last_frame_slug, first_clip_slug, driving_audio_slug, video_slug,
        resolution, duration, prompt_extend, watermark, audio_setting, seed,
      } = args as Args;

      if (!process.env.DASHSCOPE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "DASHSCOPE_API_KEY environment variable is not set" }],
        };
      }

      if (!first_frame_slug && !last_frame_slug && !first_clip_slug && !driving_audio_slug && !video_slug) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "Alibaba Video Synthesis requires at least one media input (first_frame_slug, last_frame_slug, first_clip_slug, driving_audio_slug, or video_slug)" }],
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

      let videoRef: RefInput | undefined;
      if (video_slug) {
        const r = await resolveVideoSlug(fs, video_slug, project_slug);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        videoRef = r.value;
      }

      const videoName = `alibaba-${slugify(prompt) || String(Date.now())}`;
      const assetResult = await fs.createAsset("vid", videoName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceImageIds = [firstFrame?.assetId, lastFrame?.assetId].filter((v): v is string => v !== undefined);
      const sourceVideoIds = [firstClip?.assetId, videoRef?.assetId].filter((v): v is string => v !== undefined);
      const sourceAudioIds = drivingAudio ? [drivingAudio.assetId] : [];

      const jobId = `alibaba-video-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_alibaba_video",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        prompt,
        ...(negative_prompt !== undefined ? { negative_prompt } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(firstFrame ? { firstFrame } : {}),
        ...(lastFrame ? { lastFrame } : {}),
        ...(firstClip ? { firstClip } : {}),
        ...(drivingAudio ? { drivingAudio } : {}),
        ...(videoRef ? { videoRef } : {}),
        sourceImageIds,
        sourceVideoIds,
        sourceAudioIds,
        ...(resolution !== undefined ? { resolution } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(prompt_extend !== undefined ? { prompt_extend } : {}),
        ...(watermark !== undefined ? { watermark } : {}),
        ...(audio_setting !== undefined ? { audio_setting } : {}),
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

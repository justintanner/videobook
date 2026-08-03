import type { Engine, ArtifactManifestFile } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import {
  AlibabaVideoSynthesisInputSchema,
  AlibabaVideoSynthesisModelSchema,
  AlibabaVideoSynthesisParametersSchema,
} from "@apicity/alibaba/zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import { findVideoFile, findAudioFile } from "videobook-engine";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import {
  apicityField,
  apicityStringField,
  apicityUnionEnumField,
} from "./schema-from-apicity.js";
import { requireAtLeastOne, toolError } from "./_shared.js";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

function findImageFile(files: ArtifactManifestFile[]): ArtifactManifestFile | null {
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

async function resolveImageSlug(fs: Engine, raw: string, _bookId: string): Promise<ResolveOk | ResolveErr> {
  const assetId = raw.replace(/^@/, "");
  if (!assetId.startsWith("img-")) return { ok: false, error: `Frame slugs must be img-* assets, got: ${assetId}` };
  const manifest = await fs.files.manifest(assetId);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findImageFile(manifest.value.files);
  if (!file) return { ok: false, error: `No image file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

// `@<assetId>/<filename>` addresses a specific sibling file inside an asset
// (e.g. `@plan/s1.mp4`). Bypasses the prefix gate so plan-driven slugs work.
async function resolveSlashedSlug(
  fs: Engine,
  raw: string,
  _bookId: string,
): Promise<ResolveOk | ResolveErr | null> {
  const stripped = raw.replace(/^@/, "");
  const slashIdx = stripped.indexOf("/");
  if (slashIdx < 0) return null;
  const assetId = stripped.slice(0, slashIdx);
  const filename = stripped.slice(slashIdx + 1);
  if (!assetId || !filename) return { ok: false, error: `Invalid slashed slug: ${raw}` };
  const manifest = await fs.files.manifest(assetId);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = manifest.value.files.find((f) => f.name === filename);
  if (!file) return { ok: false, error: `File ${filename} not found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename } };
}

async function resolveVideoSlug(fs: Engine, raw: string, bookId: string): Promise<ResolveOk | ResolveErr> {
  const slashed = await resolveSlashedSlug(fs, raw, bookId);
  if (slashed !== null) return slashed;
  const assetId = raw.replace(/^@/, "");
  if (!assetId.startsWith("vid-")) return { ok: false, error: `Video slugs must be vid-* assets, got: ${assetId}` };
  const manifest = await fs.files.manifest(assetId);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findVideoFile(manifest.value.files);
  if (!file) return { ok: false, error: `No video file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

async function resolveAudioSlug(fs: Engine, raw: string, bookId: string): Promise<ResolveOk | ResolveErr> {
  const slashed = await resolveSlashedSlug(fs, raw, bookId);
  if (slashed !== null) return slashed;
  const assetId = raw.replace(/^@/, "");
  if (!assetId.startsWith("aud-")) return { ok: false, error: `Audio slugs must be aud-* assets, got: ${assetId}` };
  const manifest = await fs.files.manifest(assetId);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findAudioFile(manifest.value.files, assetId);
  if (!file) return { ok: false, error: `No audio file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

const generateAlibabaVideoSchema = {
  book_id: z.string().describe("Project slug"),
  prompt: apicityStringField(AlibabaVideoSynthesisInputSchema.shape.prompt, "Video description", { required: true }),
  negative_prompt: apicityStringField(AlibabaVideoSynthesisInputSchema.shape.negative_prompt, "Negative prompt — things to avoid"),
  model: apicityUnionEnumField(AlibabaVideoSynthesisModelSchema, "DashScope video model name ('wan2.7-i2v' or 'wan2.7-videoedit')", { required: true }),
  first_frame_slug: z.string().optional().describe("First frame image asset (e.g., @img-start)"),
  last_frame_slug: z.string().optional().describe("Last frame image asset (e.g., @img-end)"),
  first_clip_slug: z.string().optional().describe("Video asset for clip continuation (e.g., @vid-scene)"),
  driving_audio_slug: z.string().optional().describe("Audio asset for audio-driven motion (e.g., @aud-music)"),
  video_slug: z.string().optional().describe("Reference video asset (e.g., @vid-ref)"),
  resolution: apicityField(AlibabaVideoSynthesisParametersSchema.shape.resolution, "Output resolution"),
  duration: apicityField(AlibabaVideoSynthesisParametersSchema.shape.duration, "Video duration in seconds (0=full source, or 2-10)"),
  prompt_extend: apicityField(AlibabaVideoSynthesisParametersSchema.shape.prompt_extend, "Intelligent prompt rewriting"),
  watermark: apicityField(AlibabaVideoSynthesisParametersSchema.shape.watermark, "Add watermark to output video"),
  audio_setting: apicityField(AlibabaVideoSynthesisParametersSchema.shape.audio_setting, "Driving-audio behavior: auto or origin"),
  seed: apicityField(AlibabaVideoSynthesisParametersSchema.shape.seed, "Random seed for reproducibility"),
  _provider: z.string().optional().describe("Provider key (e.g., 'alibaba')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateAlibabaVideoSchema>;

export function generateAlibabaVideoDef(fs: Engine): ToolDef {
  return {
    name: "generate_alibaba_wan_2_7_video",
    description: "Generate a video using Alibaba Cloud DashScope Video Synthesis. Requires at least one media input (first/last frame, reference video, driving audio, or clip continuation). Creates a new vid- asset and enqueues a background job.",
    schema: generateAlibabaVideoSchema,
    handler: async (args) => {
      const {
        book_id, prompt, negative_prompt, model,
        first_frame_slug, last_frame_slug, first_clip_slug, driving_audio_slug, video_slug,
        resolution, duration, prompt_extend, watermark, audio_setting, seed,
      } = args as Args;
      const resolvedModel = AlibabaVideoSynthesisModelSchema.parse(model);

      if (!process.env.DASHSCOPE_API_KEY) {
        return toolError("DASHSCOPE_API_KEY environment variable is not set");
      }

      const missingInput = requireAtLeastOne("generate_alibaba_wan_2_7_video", [
        { name: "first_frame_slug", value: first_frame_slug },
        { name: "last_frame_slug", value: last_frame_slug },
        { name: "first_clip_slug", value: first_clip_slug },
        { name: "driving_audio_slug", value: driving_audio_slug },
        { name: "video_slug", value: video_slug },
      ]);
      if (missingInput) return missingInput;

      let firstFrame: RefInput | undefined;
      if (first_frame_slug) {
        const r = await resolveImageSlug(fs, first_frame_slug, book_id);
        if (!r.ok) return toolError(r.error);
        firstFrame = r.value;
      }

      let lastFrame: RefInput | undefined;
      if (last_frame_slug) {
        const r = await resolveImageSlug(fs, last_frame_slug, book_id);
        if (!r.ok) return toolError(r.error);
        lastFrame = r.value;
      }

      let firstClip: RefInput | undefined;
      if (first_clip_slug) {
        const r = await resolveVideoSlug(fs, first_clip_slug, book_id);
        if (!r.ok) return toolError(r.error);
        firstClip = r.value;
      }

      let drivingAudio: RefInput | undefined;
      if (driving_audio_slug) {
        const r = await resolveAudioSlug(fs, driving_audio_slug, book_id);
        if (!r.ok) return toolError(r.error);
        drivingAudio = r.value;
      }

      let videoRef: RefInput | undefined;
      if (video_slug) {
        const r = await resolveVideoSlug(fs, video_slug, book_id);
        if (!r.ok) return toolError(r.error);
        videoRef = r.value;
      }

      const videoName = `alibaba-${slugify(prompt) || String(Date.now())}`;
      const assetResult = await fs.artifacts.create("vid", videoName);
      if (!assetResult.ok) {
        return toolError(`Failed to create video asset: ${assetResult.error.message}`);
      }

      const { slug: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceImageIds = [firstFrame?.assetId, lastFrame?.assetId].filter((v): v is string => v !== undefined);
      const sourceVideoIds = [firstClip?.assetId, videoRef?.assetId].filter((v): v is string => v !== undefined);
      const sourceAudioIds = drivingAudio ? [drivingAudio.assetId] : [];

      const jobId = `alibaba-video-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_alibaba_video",
        vidAssetId,
        vidAssetDir,
        bookId: book_id,
        prompt,
        ...(negative_prompt !== undefined ? { negative_prompt } : {}),
        model: resolvedModel,
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

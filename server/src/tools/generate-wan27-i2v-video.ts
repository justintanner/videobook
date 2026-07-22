import type { VideocityFs, AssetManifestFile } from "videocity-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { Wan27ImageToVideoRequestSchema } from "@apicity/kie/zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import { findAudioFile, findVideoFile } from "videocity-engine";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { zodErrorToToolResult } from "./_shared.js";
import { apicityField, apicityStringField, apicityStringNumberField } from "./schema-from-apicity.js";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);
const wan27I2v = Wan27ImageToVideoRequestSchema.shape.input.shape;

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

async function resolveVideoSlug(fs: VideocityFs, raw: string, projectSlug: string): Promise<ResolveOk | ResolveErr> {
  const assetId = raw.replace(/^@/, "");
  if (!assetId.startsWith("vid-")) return { ok: false, error: `first_clip_slug must be a vid-* asset, got: ${assetId}` };
  const manifest = await fs.getManifest(assetId, projectSlug);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findVideoFile(manifest.value.files);
  if (!file) return { ok: false, error: `No video file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

async function resolveAudioSlug(fs: VideocityFs, raw: string, projectSlug: string): Promise<ResolveOk | ResolveErr> {
  const assetId = raw.replace(/^@/, "");
  if (!assetId.startsWith("aud-")) return { ok: false, error: `driving_audio_slug must be an aud-* asset, got: ${assetId}` };
  const manifest = await fs.getManifest(assetId, projectSlug);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findAudioFile(manifest.value.files, assetId);
  if (!file) return { ok: false, error: `No audio file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

const generateWan27I2vVideoSchema = {
  project_slug: z.string().describe("Project slug"),
  prompt: apicityStringField(wan27I2v.prompt, "Video description (max 5000 chars)", { required: true }),
  negative_prompt: apicityStringField(wan27I2v.negative_prompt, "Negative prompt — things to avoid (max 500 chars)"),
  first_frame_slug: apicityStringField(wan27I2v.first_frame_url, "First frame image asset (e.g., @img-start)"),
  last_frame_slug: apicityStringField(wan27I2v.last_frame_url, "Last frame image asset (e.g., @img-end)"),
  first_clip_slug: apicityStringField(wan27I2v.first_clip_url, "Video asset for continuation (e.g., @vid-scene)"),
  driving_audio_slug: apicityStringField(wan27I2v.driving_audio_url, "Audio asset for audio-driven motion (e.g., @aud-music)"),
  resolution: apicityField(wan27I2v.resolution, "Video resolution (default 1080p)"),
  duration: apicityStringNumberField(wan27I2v.duration, "Video duration in seconds (2-15)"),
  prompt_extend: apicityField(wan27I2v.prompt_extend, "Intelligent prompt rewriting (default true)"),
  watermark: apicityField(wan27I2v.watermark, "Add provider watermark to output (default false)"),
  nsfw_checker: apicityField(wan27I2v.nsfw_checker, "Content safety filter (default false)"),
  seed: apicityField(wan27I2v.seed, "Random seed for reproducibility"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateWan27I2vVideoSchema>;

export function generateWan27I2vVideoDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_kie_wan_2_7_image_to_video",
    description: "Generate a video using Wan 2.7 Image to Video with first/last frame image control, clip continuation, or driving audio. Creates a new vid- asset and enqueues a background job.",
    schema: generateWan27I2vVideoSchema,
    handler: async (args) => {
      const {
        project_slug, prompt, negative_prompt,
        first_frame_slug, last_frame_slug, first_clip_slug, driving_audio_slug,
        resolution, duration, prompt_extend, watermark, nsfw_checker, seed,
      } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      // Apicity Wan27ImageToVideoRequestSchema refines enforce:
      //   - at least one of first_frame_url, last_frame_url, first_clip_url
      //   - first_clip_url cannot be combined with first_frame_url or last_frame_url
      // Only the refine-relevant fields are passed; slugs stand in for URLs
      // (apicity accepts any string), and unrelated fields (duration, seed)
      // are omitted so their per-field types don't need coercion here.
      const apicityCheck = Wan27ImageToVideoRequestSchema.safeParse({
        model: "wan/2-7-image-to-video",
        input: {
          prompt,
          ...(first_frame_slug ? { first_frame_url: first_frame_slug } : {}),
          ...(last_frame_slug ? { last_frame_url: last_frame_slug } : {}),
          ...(first_clip_slug ? { first_clip_url: first_clip_slug } : {}),
        },
      });
      if (!apicityCheck.success) return zodErrorToToolResult(apicityCheck.error);

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

      const videoName = `${modelSlug("kie", "wan/2-7-image-to-video")}-${slugify(prompt) || String(Date.now())}`;
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

      const jobId = `${modelSlug("kie", "wan/2-7-image-to-video")}-i2v-${vidAssetId}-${Date.now()}`;

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

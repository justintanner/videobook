import type { ClipfirstFs, AssetManifestFile } from "clipfirst-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { Seedance2FastRequestSchema } from "@apicity/kie/zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import { findAudioFile, findVideoFile } from "clipfirst-engine";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { zodErrorToToolResult } from "./_shared.js";

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

const seedance2FastInputSchema = Seedance2FastRequestSchema.shape.input.shape;

const generateSeedance2ReferenceVideoSchema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().describe("Video description (3-2500 characters)"),
  image_slugs: z.array(z.string()).optional().describe("1-9 reference image @slugs (e.g., @img-style)"),
  video_slugs: z.array(z.string()).optional().describe("0-3 reference video @slugs, total ≤15s (e.g., @vid-motion)"),
  audio_slugs: z.array(z.string()).optional().describe("0-3 reference audio @slugs, total ≤15s (e.g., @aud-music)"),
  model: z.enum(["bytedance/seedance-2-fast", "bytedance/seedance-2"]).optional().describe("Seedance model variant (fast default, standard adds 1080p)"),
  aspect_ratio: z.enum(seedance2FastInputSchema.aspect_ratio.unwrap().options).optional().describe("Output aspect ratio"),
  resolution: z.enum(["480p", "720p", "1080p"]).optional().describe("Output resolution (1080p requires model=bytedance/seedance-2)"),
  duration: z.string().optional().describe("Video duration in seconds (4-15)"),
  generate_audio: z.boolean().optional().describe("Generate accompanying audio (default true)"),
  return_last_frame: z.boolean().optional().describe("Return the final frame as an image (default false)"),
  web_search: z.boolean().optional().describe("Use web search for enhanced grounding (default false)"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateSeedance2ReferenceVideoSchema>;

export function generateSeedance2ReferenceVideoDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_seedance2_reference_video",
    description: "Generate a video using ByteDance Seedance 2.0 Fast guided by reference images (1-9), videos (0-3), and/or audio (0-3). Creates a new vid- asset and enqueues a background job.",
    schema: generateSeedance2ReferenceVideoSchema,
    handler: async (args) => {
      const {
        project_slug, prompt,
        image_slugs, video_slugs, audio_slugs,
        model, aspect_ratio, resolution, duration,
        generate_audio, return_last_frame, web_search,
      } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      if (resolution === "1080p" && model !== "bytedance/seedance-2") {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "resolution '1080p' requires model='bytedance/seedance-2' (the fast variant tops out at 720p)" }],
        };
      }

      const imgs = image_slugs ?? [];
      const vids = video_slugs ?? [];
      const auds = audio_slugs ?? [];

      // Apicity Seedance2FastRequestSchema caps reference arrays at 9/3/3.
      // The at-least-one rule is not encoded in apicity (the schema covers
      // t2v, frames, and reference modes) — enforce it here.
      if (imgs.length === 0 && vids.length === 0 && auds.length === 0) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "Seedance 2.0 Reference mode requires at least one reference asset (image, video, or audio)" }],
        };
      }
      const apicityCheck = Seedance2FastRequestSchema.safeParse({
        model: "bytedance/seedance-2-fast",
        input: {
          prompt,
          web_search: web_search ?? false,
          ...(imgs.length > 0 ? { reference_image_urls: imgs } : {}),
          ...(vids.length > 0 ? { reference_video_urls: vids } : {}),
          ...(auds.length > 0 ? { reference_audio_urls: auds } : {}),
        },
      });
      if (!apicityCheck.success) return zodErrorToToolResult(apicityCheck.error);

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

      const videoName = `${modelSlug("kie", "bytedance/seedance-2")}-${slugify(prompt) || String(Date.now())}`;
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

      const jobId = `${modelSlug("kie", "bytedance/seedance-2")}-r2v-${vidAssetId}-${Date.now()}`;

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
        ...(model !== undefined ? { model } : {}),
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

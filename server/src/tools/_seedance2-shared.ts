import type { VideocityFs, AssetManifestFile } from "videocity-engine";
import { findAudioFile, findVideoFile } from "videocity-engine";
import { extname } from "node:path";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import {
  Seedance2FastInputSchema,
  Seedance2FastRequestSchema,
  Seedance2RequestSchema,
} from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { zodErrorToToolResult } from "./_shared.js";
import { apicityField } from "./schema-from-apicity.js";

type Seedance2Model = "bytedance/seedance-2" | "bytedance/seedance-2-fast";
type Resolution = "480p" | "720p" | "1080p";

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

export type RefInput = { assetId: string; filename: string };

type ResolveOk = { ok: true; value: RefInput };
type ResolveErr = { ok: false; error: string };

async function resolveImageSlug(fs: VideocityFs, raw: string, projectSlug: string): Promise<ResolveOk | ResolveErr> {
  const assetId = raw.replace(/^@/, "");
  if (!assetId.startsWith("img-")) return { ok: false, error: `image slug must be img-* asset, got: ${assetId}` };
  const manifest = await fs.getManifest(assetId, projectSlug);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findImageFile(manifest.value.files);
  if (!file) return { ok: false, error: `No image file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

// `@<assetId>/<filename>` addresses a specific sibling file inside an
// asset. Used by plan-driven render (e.g. `@plan/s1.mp4`); bypasses the
// vid-/aud- prefix gate since the destination asset doesn't have to be
// media-prefixed and may hold multiple media files.
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
  if (!assetId.startsWith("vid-")) return { ok: false, error: `video slug must be vid-* asset, got: ${assetId}` };
  const manifest = await fs.getManifest(assetId, projectSlug);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findVideoFile(manifest.value.files);
  if (!file) return { ok: false, error: `No video file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

// Resolve an audio reference: `@<assetId>/<filename>` (e.g. `@plan/s1.mp3`)
// first, falling back to the aud-* asset gate. Exported for reuse by other
// generators that splice scene audio (e.g. Grok Imagine i2v).
export async function resolveAudioSlug(fs: VideocityFs, raw: string, projectSlug: string): Promise<ResolveOk | ResolveErr> {
  const slashed = await resolveSlashedSlug(fs, raw, projectSlug);
  if (slashed !== null) return slashed;
  const assetId = raw.replace(/^@/, "");
  if (!assetId.startsWith("aud-")) return { ok: false, error: `audio slug must be aud-* asset, got: ${assetId}` };
  const manifest = await fs.getManifest(assetId, projectSlug);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findAudioFile(manifest.value.files, assetId);
  if (!file) return { ok: false, error: `No audio file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

const seedance2InputSchema = Seedance2FastInputSchema.shape;

function buildSchema(resolutions: readonly Resolution[]) {
  return {
    project_slug: z.string().describe("Project slug"),
    prompt: z.string().describe("Video description (3-20000 characters)"),
    first_frame_slug: z.string().optional().describe("First frame image asset (e.g., @img-start)"),
    last_frame_slug: z.string().optional().describe("Last frame image asset (e.g., @img-end)"),
    image_slugs: z.array(z.string()).optional().describe("Reference image @slugs (0-9, e.g., @img-style)"),
    video_slugs: z.array(z.string()).optional().describe("Reference video @slugs (0-3, total ≤15s, e.g., @vid-motion)"),
    audio_slugs: z.array(z.string()).optional().describe("Reference audio @slugs (0-3, total ≤15s, e.g., @aud-music)"),
    aspect_ratio: apicityField(seedance2InputSchema.aspect_ratio, "Output aspect ratio"),
    resolution: z.enum(resolutions as [Resolution, ...Resolution[]]).optional().describe("Output resolution"),
    duration: z.string().optional().describe("Video duration in seconds (4-15)"),
    generate_audio: z.boolean().optional().describe("Generate accompanying audio (default true)"),
    web_search: z.boolean().optional().describe("Use web search for grounding (default false)"),
    nsfw_checker: z.boolean().optional().describe("Content safety filter (default false)"),
    replace_audio_with: z.string().optional().describe("After generation, splice this audio over the seedance output (aud-* slug or `<assetId>/<filename>` form, e.g. `plan/s1.mp3`). Runs server-side as part of the generation pipeline so the asset only reaches 'ready' once the splice is in."),
    _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
  } satisfies ZodRawShape;
}

type Seedance2ToolFactoryOpts = {
  toolName: string;
  description: string;
  apiModel: Seedance2Model;
  resolutions: readonly Resolution[];
};

export function buildSeedance2ToolDef(
  fs: VideocityFs,
  opts: Seedance2ToolFactoryOpts,
): ToolDef {
  const schema = buildSchema(opts.resolutions);
  type Args = SchemaArgs<typeof schema>;

  return {
    name: opts.toolName,
    description: opts.description,
    schema,
    handler: async (args) => {
      const raw = args as Args;
      const {
        project_slug, prompt,
        image_slugs, video_slugs, audio_slugs,
        aspect_ratio, resolution, duration,
        generate_audio, web_search, nsfw_checker,
      } = raw;
      const blank = (v: unknown): v is "" => typeof v === "string" && v.trim() === "";
      const first_frame_slug = blank(raw.first_frame_slug) ? undefined : raw.first_frame_slug;
      const last_frame_slug = blank(raw.last_frame_slug) ? undefined : raw.last_frame_slug;
      const replace_audio_with = blank(raw.replace_audio_with) ? undefined : raw.replace_audio_with;

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      if (resolution !== undefined && !opts.resolutions.includes(resolution as Resolution)) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `resolution '${resolution}' not supported by ${opts.apiModel} (allowed: ${opts.resolutions.join(", ")})` }],
        };
      }

      const dropBlanks = (xs: string[] | undefined): string[] =>
        (xs ?? []).filter((s) => !blank(s));
      const imgs = dropBlanks(image_slugs);
      const vids = dropBlanks(video_slugs);
      const auds = dropBlanks(audio_slugs);

      if (auds.length > 0 && (first_frame_slug !== undefined || last_frame_slug !== undefined)) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "Seedance 2 does not support reference audio combined with first/last frame — pick one or the other" }],
        };
      }

      const requestSchema = opts.apiModel === "bytedance/seedance-2"
        ? Seedance2RequestSchema
        : Seedance2FastRequestSchema;
      const apicityCheck = requestSchema.safeParse({
        model: opts.apiModel,
        input: {
          prompt,
          web_search: web_search ?? false,
          nsfw_checker: nsfw_checker ?? false,
          ...(first_frame_slug !== undefined ? { first_frame_url: first_frame_slug } : {}),
          ...(last_frame_slug !== undefined ? { last_frame_url: last_frame_slug } : {}),
          ...(imgs.length > 0 ? { reference_image_urls: imgs } : {}),
          ...(vids.length > 0 ? { reference_video_urls: vids } : {}),
          ...(auds.length > 0 ? { reference_audio_urls: auds } : {}),
          ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
          ...(resolution !== undefined ? { resolution } : {}),
          ...(duration !== undefined ? { duration: parseInt(duration, 10) } : {}),
          ...(generate_audio !== undefined ? { generate_audio } : {}),
        },
      });
      if (!apicityCheck.success) return zodErrorToToolResult(apicityCheck.error);

      let firstFrame: RefInput | undefined;
      if (first_frame_slug !== undefined) {
        const r = await resolveImageSlug(fs, first_frame_slug, project_slug);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        firstFrame = r.value;
      }

      let lastFrame: RefInput | undefined;
      if (last_frame_slug !== undefined) {
        const r = await resolveImageSlug(fs, last_frame_slug, project_slug);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        lastFrame = r.value;
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

      let replaceAudioWith: RefInput | undefined;
      if (replace_audio_with !== undefined) {
        const r = await resolveAudioSlug(fs, replace_audio_with, project_slug);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: `replace_audio_with: ${r.error}` }] };
        replaceAudioWith = r.value;
      }

      const videoName = `${modelSlug("kie", opts.apiModel)}-${slugify(prompt) || String(Date.now())}`;
      const assetResult = await fs.createAsset("vid", videoName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceImageIds: string[] = [];
      if (firstFrame) sourceImageIds.push(firstFrame.assetId);
      if (lastFrame && lastFrame.assetId !== firstFrame?.assetId) sourceImageIds.push(lastFrame.assetId);
      for (const i of imageInputs) sourceImageIds.push(i.assetId);
      const sourceVideoIds = videoInputs.map((i) => i.assetId);
      const sourceAudioIds = audioInputs.map((i) => i.assetId);

      const jobId = `${modelSlug("kie", opts.apiModel)}-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: opts.toolName,
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        prompt,
        apiModel: opts.apiModel,
        ...(firstFrame ? { firstFrame } : {}),
        ...(lastFrame ? { lastFrame } : {}),
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
        web_search: web_search ?? false,
        ...(nsfw_checker !== undefined ? { nsfw_checker } : {}),
        ...(replaceAudioWith ? { replaceAudioWith } : {}),
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

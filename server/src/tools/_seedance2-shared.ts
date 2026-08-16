import type { Engine, ArtifactManifestFile } from "videobook-engine";
import { findAudioFile, findVideoFile } from "videobook-engine";
import { extname } from "node:path";
import { modelSlug } from "@apicity/cost";
import type { Seedance2FastRequest, Seedance2Request } from "@apicity/kie";
import { z, type ZodRawShape } from "zod";
import {
  Seedance2InputSchema,
  Seedance2FastInputSchema,
  Seedance2FastRequestSchema,
  Seedance2RequestSchema,
} from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { zodErrorToToolResult } from "./_shared.js";
import {
  apicityField,
  apicityStringArrayField,
  apicityStringField,
  apicityStringNumberField,
} from "./schema-from-apicity.js";
import { generationLabel } from "../artifact-label.js";

type Seedance2Model = Seedance2Request["model"] | Seedance2FastRequest["model"];

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "bmp", "tif", "tiff", "gif"]);

function findImageFile(files: ArtifactManifestFile[]): ArtifactManifestFile | null {
  const images = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
  return images.find((f) => f.name.startsWith("original")) ?? images[0] ?? null;
}

export type RefInput = { assetId: string; filename: string };

type ResolveOk = { ok: true; value: RefInput };
type ResolveErr = { ok: false; error: string };

export async function resolveImageRef(fs: Engine, raw: string): Promise<ResolveOk | ResolveErr> {
  const assetId = raw.replace(/^@/, "");
  const artifact = fs.artifacts.get(assetId);
  if (!artifact.ok) return { ok: false, error: artifact.error.message };
  if (artifact.value.kind !== "image") {
    return { ok: false, error: `image ref must be an image artifact, got ${artifact.value.kind}: ${assetId}` };
  }
  const manifest = await fs.files.manifest(assetId);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findImageFile(manifest.value.files);
  if (!file) return { ok: false, error: `No image file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

// `@<assetId>/<filename>` addresses a specific sibling file inside an
// asset. Used by plan-driven render (e.g. `@plan/s1.mp4`); bypasses the
// artifact-kind gate since the destination asset may hold multiple media
// files of mixed kinds.
async function resolveSlashedRef(
  fs: Engine,
  raw: string,
): Promise<ResolveOk | ResolveErr | null> {
  const stripped = raw.replace(/^@/, "");
  const slashIdx = stripped.indexOf("/");
  if (slashIdx < 0) return null;
  const assetId = stripped.slice(0, slashIdx);
  const filename = stripped.slice(slashIdx + 1);
  if (!assetId || !filename) return { ok: false, error: `Invalid slashed ref: ${raw}` };
  const manifest = await fs.files.manifest(assetId);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = manifest.value.files.find((f) => f.name === filename);
  if (!file) return { ok: false, error: `File ${filename} not found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename } };
}

export async function resolveVideoRef(fs: Engine, raw: string): Promise<ResolveOk | ResolveErr> {
  const slashed = await resolveSlashedRef(fs, raw);
  if (slashed !== null) return slashed;
  const assetId = raw.replace(/^@/, "");
  const artifact = fs.artifacts.get(assetId);
  if (!artifact.ok) return { ok: false, error: artifact.error.message };
  if (artifact.value.kind !== "video") {
    return { ok: false, error: `video ref must be a video artifact, got ${artifact.value.kind}: ${assetId}` };
  }
  const manifest = await fs.files.manifest(assetId);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findVideoFile(manifest.value.files);
  if (!file) return { ok: false, error: `No video file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

// Audio replacement always targets a first-class audio artifact. Notebook
// cells reference artifact identities; they do not expose nested file paths.
export async function resolveAudioRef(fs: Engine, raw: string): Promise<ResolveOk | ResolveErr> {
  const assetId = raw.replace(/^@/, "");
  const artifact = fs.artifacts.get(assetId);
  if (!artifact.ok) return { ok: false, error: artifact.error.message };
  if (artifact.value.kind !== "audio") {
    return { ok: false, error: `audio ref must be an audio artifact, got ${artifact.value.kind}: ${assetId}` };
  }
  const manifest = await fs.files.manifest(assetId);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findAudioFile(manifest.value.files, "audio");
  if (!file) return { ok: false, error: `No audio file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

export function buildSeedance2Schema(apiModel: Seedance2Model) {
  const inputSchema = apiModel === "bytedance/seedance-2"
    ? Seedance2InputSchema.shape
    : Seedance2FastInputSchema.shape;
  return {
    book_id: z.string().describe("Book id"),
    prompt: apicityStringField(inputSchema.prompt, "Video description (3-20000 characters)", { required: true }),
    first_frame_ref: apicityStringField(inputSchema.first_frame_url, "First frame image artifact id"),
    last_frame_ref: apicityStringField(inputSchema.last_frame_url, "Last frame image artifact id"),
    image_refs: apicityStringArrayField(inputSchema.reference_image_urls, "Reference image artifact ids (0-9)"),
    video_refs: apicityStringArrayField(inputSchema.reference_video_urls, "Reference video artifact ids (0-3, total ≤15s)"),
    audio_refs: apicityStringArrayField(inputSchema.reference_audio_urls, "Reference audio artifact ids (0-3, total ≤15s)"),
    aspect_ratio: apicityField(inputSchema.aspect_ratio, "Output aspect ratio"),
    resolution: apicityField(inputSchema.resolution, "Output resolution"),
    duration: apicityStringNumberField(inputSchema.duration, "Video duration in seconds (4-15)"),
    generate_audio: apicityField(inputSchema.generate_audio, "Generate accompanying audio (default true)"),
    web_search: apicityField(inputSchema.web_search, "Use web search for grounding (default false)"),
    nsfw_checker: apicityField(inputSchema.nsfw_checker, "Content safety filter (default false)"),
    replace_audio_with: z.string().optional().describe("After generation, splice an audio artifact over the Seedance output. Runs server-side as part of the generation pipeline so the asset only reaches 'ready' once the splice is in."),
    _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
  } satisfies ZodRawShape;
}

type Seedance2ToolFactoryOpts = {
  toolName: string;
  jobType: string;
  description: string;
  apiModel: Seedance2Model;
};

export function buildSeedance2ToolDef(
  fs: Engine,
  opts: Seedance2ToolFactoryOpts,
): ToolDef {
  const schema = buildSeedance2Schema(opts.apiModel);
  type Args = SchemaArgs<typeof schema>;

  return {
    name: opts.toolName,
    description: opts.description,
    schema,
    handler: async (args) => {
      const raw = args as Args;
      const {
        book_id, prompt,
        image_refs, video_refs, audio_refs,
        aspect_ratio, resolution, duration,
        generate_audio, web_search, nsfw_checker,
      } = raw;
      const blank = (v: unknown): v is "" => typeof v === "string" && v.trim() === "";
      const first_frame_ref = blank(raw.first_frame_ref) ? undefined : raw.first_frame_ref;
      const last_frame_ref = blank(raw.last_frame_ref) ? undefined : raw.last_frame_ref;
      const replace_audio_with = blank(raw.replace_audio_with) ? undefined : raw.replace_audio_with;

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      const dropBlanks = (xs: string[] | undefined): string[] =>
        (xs ?? []).filter((s) => !blank(s));
      const imgs = dropBlanks(image_refs);
      const vids = dropBlanks(video_refs);
      const auds = dropBlanks(audio_refs);

      if (auds.length > 0 && (first_frame_ref !== undefined || last_frame_ref !== undefined)) {
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
          ...(first_frame_ref !== undefined ? { first_frame_url: first_frame_ref } : {}),
          ...(last_frame_ref !== undefined ? { last_frame_url: last_frame_ref } : {}),
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
      if (first_frame_ref !== undefined) {
        const r = await resolveImageRef(fs, first_frame_ref);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        firstFrame = r.value;
      }

      let lastFrame: RefInput | undefined;
      if (last_frame_ref !== undefined) {
        const r = await resolveImageRef(fs, last_frame_ref);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        lastFrame = r.value;
      }

      const imageInputs: RefInput[] = [];
      for (const raw of imgs) {
        const r = await resolveImageRef(fs, raw);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        imageInputs.push(r.value);
      }

      const videoInputs: RefInput[] = [];
      for (const raw of vids) {
        const r = await resolveVideoRef(fs, raw);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        videoInputs.push(r.value);
      }

      const audioInputs: RefInput[] = [];
      for (const raw of auds) {
        const r = await resolveAudioRef(fs, raw);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        audioInputs.push(r.value);
      }

      let replaceAudioWith: RefInput | undefined;
      if (replace_audio_with !== undefined) {
        const r = await resolveAudioRef(fs, replace_audio_with);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: `replace_audio_with: ${r.error}` }] };
        replaceAudioWith = r.value;
      }

      const videoName = generationLabel(modelSlug("kie", opts.apiModel), prompt);
      const assetResult = await fs.artifacts.create("vid", videoName);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }],
        };
      }

      const { artifactId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceImageIds: string[] = [];
      if (firstFrame) sourceImageIds.push(firstFrame.assetId);
      if (lastFrame && lastFrame.assetId !== firstFrame?.assetId) sourceImageIds.push(lastFrame.assetId);
      for (const i of imageInputs) sourceImageIds.push(i.assetId);
      const sourceVideoIds = videoInputs.map((i) => i.assetId);
      const sourceAudioIds = audioInputs.map((i) => i.assetId);

      const jobId = `${modelSlug("kie", opts.apiModel)}-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: opts.jobType,
        vidAssetId,
        vidAssetDir,
        bookId: book_id,
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

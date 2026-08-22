import type { Engine, ArtifactManifestFile } from "videobook-engine";
import { findAudioFile, findVideoFile } from "videobook-engine";
import { extname } from "node:path";
import type { Seedance2FastRequest, Seedance2Request } from "@apicity/kie";
import { z, type ZodRawShape } from "zod";
import {
  Seedance2InputSchema,
  Seedance2FastInputSchema,
} from "@apicity/kie/zod";
import {
  apicityField,
  apicityStringArrayField,
  apicityStringField,
  apicityStringNumberField,
} from "./schema-from-apicity.js";

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

export async function resolveImageRef(engine: Engine, raw: string): Promise<ResolveOk | ResolveErr> {
  const assetId = raw.replace(/^@/, "");
  const artifact = engine.artifacts.get(assetId);
  if (!artifact.ok) return { ok: false, error: artifact.error.message };
  if (artifact.value.kind !== "image") {
    return { ok: false, error: `image ref must be an image artifact, got ${artifact.value.kind}: ${assetId}` };
  }
  const manifest = await engine.files.manifest(assetId);
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
  engine: Engine,
  raw: string,
): Promise<ResolveOk | ResolveErr | null> {
  const stripped = raw.replace(/^@/, "");
  const slashIdx = stripped.indexOf("/");
  if (slashIdx < 0) return null;
  const assetId = stripped.slice(0, slashIdx);
  const filename = stripped.slice(slashIdx + 1);
  if (!assetId || !filename) return { ok: false, error: `Invalid slashed ref: ${raw}` };
  const manifest = await engine.files.manifest(assetId);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = manifest.value.files.find((f) => f.name === filename);
  if (!file) return { ok: false, error: `File ${filename} not found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename } };
}

export async function resolveVideoRef(engine: Engine, raw: string): Promise<ResolveOk | ResolveErr> {
  const slashed = await resolveSlashedRef(engine, raw);
  if (slashed !== null) return slashed;
  const assetId = raw.replace(/^@/, "");
  const artifact = engine.artifacts.get(assetId);
  if (!artifact.ok) return { ok: false, error: artifact.error.message };
  if (artifact.value.kind !== "video") {
    return { ok: false, error: `video ref must be a video artifact, got ${artifact.value.kind}: ${assetId}` };
  }
  const manifest = await engine.files.manifest(assetId);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findVideoFile(manifest.value.files);
  if (!file) return { ok: false, error: `No video file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

// Audio replacement always targets a first-class audio artifact. Notebook
// cells reference artifact identities; they do not expose nested file paths.
export async function resolveAudioRef(engine: Engine, raw: string): Promise<ResolveOk | ResolveErr> {
  const assetId = raw.replace(/^@/, "");
  const artifact = engine.artifacts.get(assetId);
  if (!artifact.ok) return { ok: false, error: artifact.error.message };
  if (artifact.value.kind !== "audio") {
    return { ok: false, error: `audio ref must be an audio artifact, got ${artifact.value.kind}: ${assetId}` };
  }
  const manifest = await engine.files.manifest(assetId);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findAudioFile(manifest.value.files, "audio");
  if (!file) return { ok: false, error: `No audio file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

export function seedanceActorReplacementPrompt(actorCount: number): string {
  const count = Math.max(1, Math.floor(actorCount));
  const lines = Array.from({ length: count }, (_, index) => {
    const image = `@Image${index + 1}`;
    return `Replace the on-screen person matching ${image} with ${image} as character reference`;
  });
  return `${lines.join(". ")}. Keep camera movement, pacing, and framing of @Video1.`;
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

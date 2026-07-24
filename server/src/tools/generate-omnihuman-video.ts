import type { Engine, ArtifactManifestFile } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import { extname } from "node:path";
import { modelSlug } from "@apicity/cost";
import { Omnihuman15RequestSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import { findAudioFile } from "videobook-engine";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { apicityField, apicityStringField } from "./schema-from-apicity.js";

const SLUG = modelSlug("kie", "omnihuman-1-5");
const omnihuman = Omnihuman15RequestSchema.shape.input.shape;

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

function findImageFile(files: ArtifactManifestFile[]): ArtifactManifestFile | null {
  const images = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
  return images.find((f) => f.name.startsWith("original")) ?? images[0] ?? null;
}

type RefInput = { assetId: string; filename: string };
type ResolveOk = { ok: true; value: RefInput };
type ResolveErr = { ok: false; error: string };

async function resolveImageSlug(fs: Engine, raw: string, _bookId: string): Promise<ResolveOk | ResolveErr> {
  const assetId = raw.replace(/^@/, "");
  if (!assetId.startsWith("img-")) {
    return { ok: false, error: `image_slug must be an img-* asset, got: ${assetId}` };
  }
  const manifest = await fs.files.manifest(assetId);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findImageFile(manifest.value.files);
  if (!file) return { ok: false, error: `No image file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

async function resolveAudioSlug(fs: Engine, raw: string, _bookId: string): Promise<ResolveOk | ResolveErr> {
  const assetId = raw.replace(/^@/, "");
  if (!assetId.startsWith("aud-")) return { ok: false, error: `audio_slug must be an aud-* asset, got: ${assetId}` };
  const manifest = await fs.files.manifest(assetId);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findAudioFile(manifest.value.files, assetId);
  if (!file) return { ok: false, error: `No audio file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

const generateOmnihumanVideoSchema = {
  book_id: z.string().describe("Project slug"),
  image_slug: apicityStringField(omnihuman.image_url, "Portrait image asset to animate (e.g., @img-face)", { required: true }),
  audio_slug: apicityStringField(omnihuman.audio_url, "Driving audio asset whose speech/song drives the avatar (max 60s, e.g., @aud-voice)", { required: true }),
  prompt: apicityStringField(omnihuman.prompt, "Optional motion/expression description (e.g. 'speaking naturally with gentle expressions')"),
  output_resolution: apicityField(omnihuman.output_resolution, "Output resolution: 720 / 1080 (default 1080)"),
  pe_fast_mode: apicityField(omnihuman.pe_fast_mode, "Prompt-enhance fast mode — faster, lower-fidelity (default false)"),
  seed: apicityField(omnihuman.seed, "Random seed for reproducibility (-1 = random)"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateOmnihumanVideoSchema>;

export function generateOmnihumanVideoDef(fs: Engine): ToolDef {
  return {
    name: "generate_kie_omnihuman_1_5_video",
    description: "Animate a portrait image with a driving audio track into a talking/singing avatar video using ByteDance OmniHuman 1.5 (kie). Creates a new vid- asset and enqueues a background job.",
    schema: generateOmnihumanVideoSchema,
    handler: async (args) => {
      const {
        book_id, image_slug, audio_slug,
        prompt, output_resolution, pe_fast_mode, seed,
      } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      if (!image_slug) {
        return { isError: true as const, content: [{ type: "text" as const, text: "OmniHuman requires image_slug" }] };
      }
      if (!audio_slug) {
        return { isError: true as const, content: [{ type: "text" as const, text: "OmniHuman requires audio_slug" }] };
      }

      const imageResult = await resolveImageSlug(fs, image_slug, book_id);
      if (!imageResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: imageResult.error }] };
      const imageInput = imageResult.value;

      const audioResult = await resolveAudioSlug(fs, audio_slug, book_id);
      if (!audioResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: audioResult.error }] };
      const audioInput = audioResult.value;

      const videoName = `${SLUG}-${imageInput.assetId.replace(/^(img|char)-/, "")}`;
      const assetResult = await fs.artifacts.create("vid", videoName);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }],
        };
      }

      const { slug: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceImageIds = [imageInput.assetId];
      const sourceAudioIds = [audioInput.assetId];

      const jobId = `${SLUG}-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_omnihuman_video",
        vidAssetId,
        vidAssetDir,
        bookId: book_id,
        imageInput,
        audioInput,
        sourceImageIds,
        sourceAudioIds,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(output_resolution !== undefined ? { output_resolution } : {}),
        ...(pe_fast_mode !== undefined ? { pe_fast_mode } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            vid_asset_id: vidAssetId,
            source_images: sourceImageIds,
            source_audios: sourceAudioIds,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}

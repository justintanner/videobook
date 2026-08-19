import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import { modelSlug } from "@apicity/cost";
import { Omnihuman15RequestSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { apicityField, apicityStringField } from "./schema-from-apicity.js";
import { resolveAudioRef, resolveImageRef } from "./_seedance2-shared.js";

const SLUG = modelSlug("kie", "omnihuman-1-5");
const omnihuman = Omnihuman15RequestSchema.shape.input.shape;

const generateOmnihumanVideoSchema = {
  book_id: z.string().describe("Book id"),
  image_ref: apicityStringField(omnihuman.image_url, "Portrait image artifact id to animate", { required: true }),
  audio_ref: apicityStringField(omnihuman.audio_url, "Driving audio artifact id whose speech/song drives the avatar (max 60s)", { required: true }),
  prompt: apicityStringField(omnihuman.prompt, "Optional motion/expression description (e.g. 'speaking naturally with gentle expressions')"),
  output_resolution: apicityField(omnihuman.output_resolution, "Output resolution: 720 / 1080 (default 1080)"),
  pe_fast_mode: apicityField(omnihuman.pe_fast_mode, "Prompt-enhance fast mode — faster, lower-fidelity (default false)"),
  seed: apicityField(omnihuman.seed, "Random seed for reproducibility (-1 = random)"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateOmnihumanVideoSchema>;

export function generateOmnihumanVideoDef(engine: Engine): ToolDef {
  return {
    name: "generate_kie_omnihuman_1_5_video",
    description: "Animate a portrait image with a driving audio track into a talking/singing avatar video using ByteDance OmniHuman 1.5 (kie). Creates a new video artifact and enqueues a background job.",
    schema: generateOmnihumanVideoSchema,
    handler: async (args) => {
      const {
        book_id, image_ref, audio_ref,
        prompt, output_resolution, pe_fast_mode, seed,
      } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      if (!image_ref) {
        return { isError: true as const, content: [{ type: "text" as const, text: "OmniHuman requires image_ref" }] };
      }
      if (!audio_ref) {
        return { isError: true as const, content: [{ type: "text" as const, text: "OmniHuman requires audio_ref" }] };
      }

      const imageResult = await resolveImageRef(engine, image_ref);
      if (!imageResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: imageResult.error }] };
      const imageInput = imageResult.value;

      const audioResult = await resolveAudioRef(engine, audio_ref);
      if (!audioResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: audioResult.error }] };
      const audioInput = audioResult.value;

      const videoName = `${SLUG}-${imageInput.assetId.replace(/^(img|char)-/, "")}`;
      const assetResult = await engine.artifacts.create("vid", videoName);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }],
        };
      }

      const { artifactId: vidAssetId, path: vidAssetDir } = assetResult.value;
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

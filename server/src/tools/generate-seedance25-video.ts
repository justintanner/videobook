import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import { Seedance25InputSchema, Seedance25RequestSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { zodErrorToToolResult } from "./_shared.js";
import {
  apicityField,
  apicityStringArrayField,
  apicityStringField,
  apicityStringNumberField,
} from "./schema-from-apicity.js";
import {
  resolveAudioRef,
  resolveImageRef,
  resolveVideoRef,
  type RefInput,
} from "./_seedance2-shared.js";
import { generationLabel } from "../artifact-label.js";

const SLUG = "sd2p5";
const seedance25Input = Seedance25InputSchema.shape;

export function buildSeedance25Schema() {
  return {
    book_id: z.string().describe("Book id"),
    prompt: apicityStringField(seedance25Input.prompt, "Video description (optional, max 30000 characters)"),
    first_frame_ref: apicityStringField(seedance25Input.first_frame_url, "First frame image artifact id"),
    last_frame_ref: apicityStringField(seedance25Input.last_frame_url, "Last frame image artifact id (requires first frame)"),
    image_refs: apicityStringArrayField(seedance25Input.reference_image_urls, "Reference image artifact ids (0-30)"),
    video_refs: apicityStringArrayField(seedance25Input.reference_video_urls, "Reference video artifact ids (0-10, total duration up to 30s)"),
    audio_refs: apicityStringArrayField(seedance25Input.reference_audio_urls, "Reference audio artifact ids (0-10)"),
    return_last_frame: apicityField(seedance25Input.return_last_frame, "Return the final generated frame as an image (default false)"),
    generate_audio: apicityField(seedance25Input.generate_audio, "Generate accompanying audio (default true)"),
    resolution: apicityField(seedance25Input.resolution, "Output resolution: 480p / 720p / 1080p (default 720p)"),
    aspect_ratio: apicityField(seedance25Input.aspect_ratio, "Output aspect ratio (default adaptive)"),
    duration: apicityStringNumberField(seedance25Input.duration, "Video duration: -1 for automatic or 4-30 seconds (default 5)"),
    output_format: apicityField(seedance25Input.output_format, "Output video format: mp4 / mov (default mp4)"),
    web_search: apicityField(seedance25Input.web_search, "Enable web search for generation"),
    nsfw_checker: apicityField(seedance25Input.nsfw_checker, "Content safety filter (default false)"),
    replace_audio_with: z.string().optional().describe("After generation, splice an audio artifact over the Seedance output. Runs server-side as part of the generation pipeline so the asset only reaches 'ready' once the splice is in."),
    _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
  } satisfies ZodRawShape;
}

const generateSeedance25VideoSchema = buildSeedance25Schema();
type Args = SchemaArgs<typeof generateSeedance25VideoSchema>;

function assetReference(value: string): string {
  return `asset://${value.replace(/^@/, "")}`;
}

function isBlank(value: unknown): value is "" {
  return typeof value === "string" && value.trim() === "";
}

function nonBlank(values: string[] | undefined): string[] {
  return (values ?? []).filter((value) => !isBlank(value));
}

export function generateSeedance25VideoDef(engine: Engine): ToolDef {
  return {
    name: "generate_kie_seedance_2_5_video",
    description: "Generate a video using ByteDance Seedance 2.5 (KIE). Supports text-only, first/last frame, and up to 30 image, 10 video, and 10 audio references with every Apicity 0.10.1 generation option including 1080p. Creates a new video artifact and enqueues a background job.",
    schema: generateSeedance25VideoSchema,
    handler: async (args) => {
      const raw = args as Args;
      const {
        book_id, prompt,
        image_refs, video_refs, audio_refs,
        return_last_frame, generate_audio,
        resolution, aspect_ratio, duration, output_format,
        web_search, nsfw_checker,
      } = raw;
      const first_frame_ref = isBlank(raw.first_frame_ref) ? undefined : raw.first_frame_ref;
      const last_frame_ref = isBlank(raw.last_frame_ref) ? undefined : raw.last_frame_ref;
      const replace_audio_with = isBlank(raw.replace_audio_with) ? undefined : raw.replace_audio_with;

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      const imgs = nonBlank(image_refs);
      const vids = nonBlank(video_refs);
      const auds = nonBlank(audio_refs);
      const apicityCheck = Seedance25RequestSchema.safeParse({
        model: "bytedance/seedance-2-5",
        input: {
          ...(prompt !== undefined ? { prompt } : {}),
          ...(first_frame_ref !== undefined ? { first_frame_url: assetReference(first_frame_ref) } : {}),
          ...(last_frame_ref !== undefined ? { last_frame_url: assetReference(last_frame_ref) } : {}),
          ...(imgs.length > 0 ? { reference_image_urls: imgs.map(assetReference) } : {}),
          ...(vids.length > 0 ? { reference_video_urls: vids.map(assetReference) } : {}),
          ...(auds.length > 0 ? { reference_audio_urls: auds.map(assetReference) } : {}),
          ...(return_last_frame !== undefined ? { return_last_frame } : {}),
          ...(generate_audio !== undefined ? { generate_audio } : {}),
          ...(resolution !== undefined ? { resolution } : {}),
          ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
          ...(duration !== undefined ? { duration: parseInt(duration, 10) } : {}),
          ...(output_format !== undefined ? { output_format } : {}),
          ...(web_search !== undefined ? { web_search } : {}),
          ...(nsfw_checker !== undefined ? { nsfw_checker } : {}),
        },
      });
      if (!apicityCheck.success) return zodErrorToToolResult(apicityCheck.error);

      let firstFrame: RefInput | undefined;
      if (first_frame_ref !== undefined) {
        const result = await resolveImageRef(engine, first_frame_ref);
        if (!result.ok) return { isError: true as const, content: [{ type: "text" as const, text: result.error }] };
        firstFrame = result.value;
      }

      let lastFrame: RefInput | undefined;
      if (last_frame_ref !== undefined) {
        const result = await resolveImageRef(engine, last_frame_ref);
        if (!result.ok) return { isError: true as const, content: [{ type: "text" as const, text: result.error }] };
        lastFrame = result.value;
      }

      const imageInputs: RefInput[] = [];
      for (const reference of imgs) {
        const result = await resolveImageRef(engine, reference);
        if (!result.ok) return { isError: true as const, content: [{ type: "text" as const, text: result.error }] };
        imageInputs.push(result.value);
      }

      const videoInputs: RefInput[] = [];
      for (const reference of vids) {
        const result = await resolveVideoRef(engine, reference);
        if (!result.ok) return { isError: true as const, content: [{ type: "text" as const, text: result.error }] };
        videoInputs.push(result.value);
      }

      const audioInputs: RefInput[] = [];
      for (const reference of auds) {
        const result = await resolveAudioRef(engine, reference);
        if (!result.ok) return { isError: true as const, content: [{ type: "text" as const, text: result.error }] };
        audioInputs.push(result.value);
      }

      let replaceAudioWith: RefInput | undefined;
      if (replace_audio_with !== undefined) {
        const result = await resolveAudioRef(engine, replace_audio_with);
        if (!result.ok) return { isError: true as const, content: [{ type: "text" as const, text: `replace_audio_with: ${result.error}` }] };
        replaceAudioWith = result.value;
      }

      const assetResult = await engine.artifacts.create("vid", generationLabel(SLUG, prompt));
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
      for (const input of imageInputs) sourceImageIds.push(input.assetId);
      const sourceVideoIds = videoInputs.map((input) => input.assetId);
      const sourceAudioIds = audioInputs.map((input) => input.assetId);
      const jobId = `${SLUG}-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_seedance25_video",
        vidAssetId,
        vidAssetDir,
        bookId: book_id,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(firstFrame ? { firstFrame } : {}),
        ...(lastFrame ? { lastFrame } : {}),
        imageInputs,
        videoInputs,
        audioInputs,
        sourceImageIds,
        sourceVideoIds,
        sourceAudioIds,
        ...(return_last_frame !== undefined ? { return_last_frame } : {}),
        ...(generate_audio !== undefined ? { generate_audio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(output_format !== undefined ? { output_format } : {}),
        ...(web_search !== undefined ? { web_search } : {}),
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

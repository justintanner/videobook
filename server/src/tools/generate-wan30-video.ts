import type { Engine } from "videobook-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import {
  Wan30VideoPrimeRequestSchema,
  Wan30VideoRequestSchema,
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
import {
  resolveAudioRef,
  resolveImageRef,
  resolveVideoRef,
  type RefInput,
} from "./_seedance2-shared.js";
import { generationLabel } from "../artifact-label.js";

const wan30Input = Wan30VideoRequestSchema.shape.input.shape;

export function buildWan30VideoSchema() {
  return {
    book_id: z.string().describe("Book id"),
    prompt: apicityStringField(
      wan30Input.prompt,
      "Video description (max 20000 chars; required for text-to-video; in reference mode address media positionally as Image1/Video1/Audio1)",
    ),
    first_frame_ref: apicityStringField(
      wan30Input.first_frame_url,
      "First frame image artifact id (frame mode; cannot combine with any reference inputs)",
    ),
    last_frame_ref: apicityStringField(
      wan30Input.last_frame_url,
      "Last frame image artifact id (frame mode; cannot combine with any reference inputs)",
    ),
    image_refs: apicityStringArrayField(
      wan30Input.reference_image_urls,
      "Reference image artifact ids (0-10)",
    ),
    video_refs: apicityStringArrayField(
      wan30Input.reference_video_urls,
      "Reference video artifact ids (0-5, each 1-15s, total ≤15s)",
    ),
    audio_refs: apicityStringArrayField(
      wan30Input.reference_audio_urls,
      "Reference audio artifact ids (0-5, each 1-15s, total ≤15s)",
    ),
    resolution: apicityField(wan30Input.resolution, "Output resolution: 480P / 720P / 1080P"),
    aspect_ratio: apicityField(wan30Input.aspect_ratio, "Output aspect ratio (default adaptive)"),
    duration: apicityStringNumberField(
      wan30Input.duration,
      "Video duration: -1 for model-chosen intelligent duration or 2-30 seconds (default 5)",
    ),
    audio: apicityField(wan30Input.audio, "Generate native audio (default true)"),
    seed: apicityField(wan30Input.seed, "Random seed for reproducibility"),
    nsfw_checker: apicityField(wan30Input.nsfw_checker, "Content safety filter (default false)"),
    _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
  } satisfies ZodRawShape;
}

const generateWan30VideoSchema = buildWan30VideoSchema();
type Args = SchemaArgs<typeof generateWan30VideoSchema>;

type Wan30Tier = {
  apiModel: "wan/3-0-video" | "wan/3-0-video-prime";
  jobType: "generate_wan30_video" | "generate_wan30_prime_video";
  requestSchema: typeof Wan30VideoRequestSchema | typeof Wan30VideoPrimeRequestSchema;
};

const STANDARD_TIER: Wan30Tier = {
  apiModel: "wan/3-0-video",
  jobType: "generate_wan30_video",
  requestSchema: Wan30VideoRequestSchema,
};

const PRIME_TIER: Wan30Tier = {
  apiModel: "wan/3-0-video-prime",
  jobType: "generate_wan30_prime_video",
  requestSchema: Wan30VideoPrimeRequestSchema,
};

function assetReference(value: string): string {
  return `asset://${value.replace(/^@/, "")}`;
}

function isBlank(value: unknown): value is "" {
  return typeof value === "string" && value.trim() === "";
}

function nonBlank(values: string[] | undefined): string[] {
  return (values ?? []).filter((value) => !isBlank(value));
}

async function resolveAll(
  engine: Engine,
  refs: string[],
  resolve: (engine: Engine, ref: string) => Promise<{ ok: true; value: RefInput } | { ok: false; error: string }>,
): Promise<{ ok: true; value: RefInput[] } | { ok: false; error: string }> {
  const resolved: RefInput[] = [];
  for (const reference of refs) {
    const result = await resolve(engine, reference);
    if (!result.ok) return result;
    resolved.push(result.value);
  }
  return { ok: true, value: resolved };
}

function fail(text: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text }],
  };
}

async function enqueueWan30(
  engine: Engine,
  tier: Wan30Tier,
  args: Args,
): Promise<ReturnType<ToolDef["handler"]>> {
  const {
    book_id, prompt,
    resolution, aspect_ratio, duration, audio, seed, nsfw_checker,
  } = args;
  const first_frame_ref = isBlank(args.first_frame_ref) ? undefined : args.first_frame_ref;
  const last_frame_ref = isBlank(args.last_frame_ref) ? undefined : args.last_frame_ref;
  const imgs = nonBlank(args.image_refs);
  const vids = nonBlank(args.video_refs);
  const auds = nonBlank(args.audio_refs);

  if (!process.env.KIE_API_KEY) {
    return fail("KIE_API_KEY environment variable is not set");
  }

  const apicityCheck = tier.requestSchema.safeParse({
    model: tier.apiModel,
    input: {
      ...(prompt !== undefined ? { prompt } : {}),
      ...(first_frame_ref !== undefined ? { first_frame_url: assetReference(first_frame_ref) } : {}),
      ...(last_frame_ref !== undefined ? { last_frame_url: assetReference(last_frame_ref) } : {}),
      ...(imgs.length > 0 ? { reference_image_urls: imgs.map(assetReference) } : {}),
      ...(vids.length > 0 ? { reference_video_urls: vids.map(assetReference) } : {}),
      ...(auds.length > 0 ? { reference_audio_urls: auds.map(assetReference) } : {}),
      ...(resolution !== undefined ? { resolution } : {}),
      ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
      ...(duration !== undefined ? { duration: parseInt(duration, 10) } : {}),
      ...(audio !== undefined ? { audio } : {}),
      ...(seed !== undefined ? { seed } : {}),
      ...(nsfw_checker !== undefined ? { nsfw_checker } : {}),
    },
  });
  if (!apicityCheck.success) return zodErrorToToolResult(apicityCheck.error);

  let firstFrame: RefInput | undefined;
  if (first_frame_ref !== undefined) {
    const result = await resolveImageRef(engine, first_frame_ref);
    if (!result.ok) return fail(result.error);
    firstFrame = result.value;
  }

  let lastFrame: RefInput | undefined;
  if (last_frame_ref !== undefined) {
    const result = await resolveImageRef(engine, last_frame_ref);
    if (!result.ok) return fail(result.error);
    lastFrame = result.value;
  }

  const imageResult = await resolveAll(engine, imgs, resolveImageRef);
  if (!imageResult.ok) return fail(imageResult.error);
  const videoResult = await resolveAll(engine, vids, resolveVideoRef);
  if (!videoResult.ok) return fail(videoResult.error);
  const audioResult = await resolveAll(engine, auds, resolveAudioRef);
  if (!audioResult.ok) return fail(audioResult.error);

  const slug = modelSlug("kie", tier.apiModel);
  const assetResult = await engine.artifacts.create("vid", generationLabel(slug, prompt));
  if (!assetResult.ok) {
    return fail(`Failed to create video asset: ${assetResult.error.message}`);
  }

  const { artifactId: vidAssetId, path: vidAssetDir } = assetResult.value;
  const sourceImageIds: string[] = [];
  if (firstFrame) sourceImageIds.push(firstFrame.assetId);
  if (lastFrame && lastFrame.assetId !== firstFrame?.assetId) sourceImageIds.push(lastFrame.assetId);
  for (const input of imageResult.value) sourceImageIds.push(input.assetId);
  const sourceVideoIds = videoResult.value.map((input) => input.assetId);
  const sourceAudioIds = audioResult.value.map((input) => input.assetId);
  const jobId = `${slug}-${vidAssetId}-${Date.now()}`;

  await queue.enqueue(jobId, {
    type: tier.jobType,
    vidAssetId,
    vidAssetDir,
    bookId: book_id,
    ...(prompt !== undefined ? { prompt } : {}),
    ...(firstFrame ? { firstFrame } : {}),
    ...(lastFrame ? { lastFrame } : {}),
    imageInputs: imageResult.value,
    videoInputs: videoResult.value,
    audioInputs: audioResult.value,
    sourceImageIds,
    sourceVideoIds,
    sourceAudioIds,
    ...(resolution !== undefined ? { resolution } : {}),
    ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(audio !== undefined ? { audio } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(nsfw_checker !== undefined ? { nsfw_checker } : {}),
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
}

export function generateKieWan30VideoDef(engine: Engine): ToolDef {
  return {
    name: "generate_kie_wan_3_0_video",
    description: "Generate a video using Wan 3.0 (KIE). One omni model covering text-to-video, first/last-frame, and reference modes with image, video, and audio references; mode is inferred from the supplied inputs. Creates a new video artifact and enqueues a background job.",
    schema: generateWan30VideoSchema,
    handler: async (args) => enqueueWan30(engine, STANDARD_TIER, args as Args),
  };
}

export function generateKieWan30PrimeVideoDef(engine: Engine): ToolDef {
  return {
    name: "generate_kie_wan_3_0_prime_video",
    description: "Generate a video using Wan 3.0 Prime (KIE), the high-speed tier. One omni model covering text-to-video, first/last-frame, and reference modes with image, video, and audio references; mode is inferred from the supplied inputs. Creates a new video artifact and enqueues a background job.",
    schema: generateWan30VideoSchema,
    handler: async (args) => enqueueWan30(engine, PRIME_TIER, args as Args),
  };
}

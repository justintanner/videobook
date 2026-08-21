import type { Engine } from "videobook-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import {
  KlingOmniImageToVideoInputSchema,
  KlingOmniImageToVideoRequestSchema,
  KlingOmniReferenceToVideoInputSchema,
  KlingOmniReferenceToVideoRequestSchema,
  KlingOmniTextToVideoInputSchema,
  KlingOmniTextToVideoRequestSchema,
  KlingOmniTransformationInputSchema,
  KlingOmniTransformationRequestSchema,
} from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { refAsPlaceholderUrl, zodErrorToToolResult } from "./_shared.js";
import {
  apicityField,
  apicityStringArrayField,
  apicityStringField,
} from "./schema-from-apicity.js";
import {
  resolveImageRef,
  resolveVideoRef,
  type RefInput,
} from "./_seedance2-shared.js";
import { generationLabel } from "../artifact-label.js";
import {
  KLING_OMNI_API_MODELS,
  KLING_OMNI_IMAGE_TO_VIDEO_TOOL,
  KLING_OMNI_JOB_TYPE,
  KLING_OMNI_REFERENCE_TO_VIDEO_TOOL,
  KLING_OMNI_TEXT_TO_VIDEO_TOOL,
  KLING_OMNI_TRANSFORMATION_TOOL,
  type KlingOmniMode,
} from "../kling-omni.js";

const textInput = KlingOmniTextToVideoInputSchema.shape;
const imageInput = KlingOmniImageToVideoInputSchema.shape;
const referenceInput = KlingOmniReferenceToVideoInputSchema.shape;
const transformationInput = KlingOmniTransformationInputSchema.shape;

type ZodLike = { _def?: unknown; unwrap?: () => unknown };

const multiPromptField = z.array(z.object({
  prompt: z.string().min(1).max(512),
  duration: z.number().int().min(1).max(15),
})).max(6).optional().describe("Custom shot list (max 6)");

function sharedOmniFields(input: {
  prompt: ZodLike;
  audio: ZodLike;
  resolution: ZodLike;
  aspect_ratio: ZodLike;
  duration: ZodLike;
  customize_multi_shots: ZodLike;
  prefer_multi_shots: ZodLike;
}) {
  return {
    book_id: z.string().describe("Book id"),
    prompt: apicityStringField(input.prompt, "Video description", { required: true }),
    audio: apicityField(input.audio, "Generate native audio"),
    resolution: apicityField(input.resolution, "Output resolution: 720p / 1080p / 4k"),
    aspect_ratio: apicityField(input.aspect_ratio, "Output aspect ratio"),
    duration: apicityField(input.duration, "Video duration in seconds"),
    customize_multi_shots: apicityField(
      input.customize_multi_shots,
      "Enable custom multi-shot list (requires multi_prompt)",
    ),
    prefer_multi_shots: apicityField(
      input.prefer_multi_shots,
      "Enable intelligent shot planning (cannot combine with customize_multi_shots)",
    ),
    multi_prompt: multiPromptField,
    _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
  };
}

export function buildKlingOmniTextSchema() {
  return {
    ...sharedOmniFields(textInput),
  } satisfies ZodRawShape;
}

export function buildKlingOmniImageSchema() {
  return {
    ...sharedOmniFields(imageInput),
    image_refs: apicityStringArrayField(
      imageInput.image_urls,
      "First-frame image, or first and last frame (1-2)",
      { required: true },
    ),
  } satisfies ZodRawShape;
}

export function buildKlingOmniReferenceSchema() {
  return {
    ...sharedOmniFields(referenceInput),
    image_refs: apicityStringArrayField(
      referenceInput.image_urls,
      "Reference image artifact ids (1-7, or 1-4 when a video is also supplied)",
    ),
    video_refs: apicityStringArrayField(
      referenceInput.video_urls,
      "Reference video artifact id (at most one)",
    ),
  } satisfies ZodRawShape;
}

export function buildKlingOmniTransformationSchema() {
  return {
    book_id: z.string().describe("Book id"),
    prompt: apicityStringField(transformationInput.prompt, "Video description", { required: true }),
    image_refs: apicityStringArrayField(
      transformationInput.image_urls,
      "Character or scene image artifact ids (1-4)",
    ),
    video_refs: apicityStringArrayField(
      transformationInput.video_urls,
      "Motion or source video artifact id",
      { required: true },
    ),
    audio: apicityField(transformationInput.audio, "Generate native audio"),
    resolution: apicityField(transformationInput.resolution, "Output resolution: 720p / 1080p / 4k"),
    aspect_ratio: apicityField(
      transformationInput.aspect_ratio,
      "Output aspect ratio (auto when video-only; 16:9 / 9:16 / 1:1 with images)",
    ),
    duration: apicityStringField(
      transformationInput.duration,
      "Optional duration string; allowed only when image_refs are present",
    ),
    _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
  } satisfies ZodRawShape;
}

const textSchema = buildKlingOmniTextSchema();
const imageSchema = buildKlingOmniImageSchema();
const referenceSchema = buildKlingOmniReferenceSchema();
const transformationSchema = buildKlingOmniTransformationSchema();

type TextArgs = SchemaArgs<typeof textSchema>;
type ImageArgs = SchemaArgs<typeof imageSchema>;
type ReferenceArgs = SchemaArgs<typeof referenceSchema>;
type TransformationArgs = SchemaArgs<typeof transformationSchema>;

function isBlank(value: unknown): value is "" {
  return typeof value === "string" && value.trim() === "";
}

function nonBlank(values: string[] | undefined): string[] {
  return (values ?? []).filter((value) => !isBlank(value));
}

function placeholderUrls(refs: string[]): string[] {
  return refs.map((ref) => refAsPlaceholderUrl(ref));
}

type OmniCommon = {
  book_id: string;
  prompt: string;
  audio?: boolean;
  resolution?: "720p" | "1080p" | "4k";
  aspect_ratio?: "16:9" | "9:16" | "1:1" | "auto";
  duration?: unknown;
  customize_multi_shots?: boolean;
  prefer_multi_shots?: boolean;
  multi_prompt?: Array<{ prompt: string; duration: number }>;
};

function omniInput(common: OmniCommon, extras: Record<string, unknown>): Record<string, unknown> {
  const multiPrompt = common.multi_prompt && common.multi_prompt.length > 0
    ? common.multi_prompt
    : undefined;
  const customize = common.customize_multi_shots ?? (multiPrompt !== undefined);
  return {
    prompt: common.prompt,
    ...(common.audio !== undefined ? { audio: common.audio } : {}),
    ...(common.resolution !== undefined ? { resolution: common.resolution } : {}),
    ...(common.aspect_ratio !== undefined ? { aspect_ratio: common.aspect_ratio } : {}),
    ...(common.duration !== undefined && common.duration !== ""
      ? { duration: common.duration }
      : {}),
    ...(customize !== undefined ? { customize_multi_shots: customize } : {}),
    ...(common.prefer_multi_shots !== undefined
      ? { prefer_multi_shots: common.prefer_multi_shots }
      : {}),
    ...(multiPrompt ? { multi_prompt: multiPrompt } : {}),
    ...extras,
  };
}

async function resolveImages(
  engine: Engine,
  refs: string[],
): Promise<{ ok: true; value: RefInput[] } | { ok: false; error: string }> {
  const resolved: RefInput[] = [];
  for (const reference of refs) {
    const result = await resolveImageRef(engine, reference);
    if (!result.ok) return result;
    resolved.push(result.value);
  }
  return { ok: true, value: resolved };
}

async function resolveVideos(
  engine: Engine,
  refs: string[],
): Promise<{ ok: true; value: RefInput[] } | { ok: false; error: string }> {
  const resolved: RefInput[] = [];
  for (const reference of refs) {
    const result = await resolveVideoRef(engine, reference);
    if (!result.ok) return result;
    resolved.push(result.value);
  }
  return { ok: true, value: resolved };
}

async function enqueueOmni(
  engine: Engine,
  mode: KlingOmniMode,
  common: OmniCommon,
  imageRefs: string[],
  videoRefs: string[],
): Promise<ReturnType<ToolDef["handler"]>> {
  if (!process.env.KIE_API_KEY) {
    return {
      isError: true as const,
      content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
    };
  }

  const apiModel = KLING_OMNI_API_MODELS[mode];
  const images = nonBlank(imageRefs);
  const videos = nonBlank(videoRefs);
  const extras: Record<string, unknown> = {};
  if (images.length > 0) extras.image_urls = placeholderUrls(images);
  if (videos.length > 0) extras.video_urls = placeholderUrls(videos);
  if (mode === "text") {
    extras.customize_multi_shots = common.customize_multi_shots
      ?? ((common.multi_prompt?.length ?? 0) > 0);
  }

  const parsed = mode === "text"
    ? KlingOmniTextToVideoRequestSchema.safeParse({
      model: apiModel,
      input: omniInput(common, extras),
    })
    : mode === "image"
      ? KlingOmniImageToVideoRequestSchema.safeParse({
        model: apiModel,
        input: omniInput(common, extras),
      })
      : mode === "reference"
        ? KlingOmniReferenceToVideoRequestSchema.safeParse({
          model: apiModel,
          input: omniInput(common, extras),
        })
        : KlingOmniTransformationRequestSchema.safeParse({
          model: apiModel,
          input: omniInput(common, extras),
        });
  if (!parsed.success) return zodErrorToToolResult(parsed.error);

  const imageResult = await resolveImages(engine, images);
  if (!imageResult.ok) {
    return { isError: true as const, content: [{ type: "text" as const, text: imageResult.error }] };
  }
  const videoResult = await resolveVideos(engine, videos);
  if (!videoResult.ok) {
    return { isError: true as const, content: [{ type: "text" as const, text: videoResult.error }] };
  }

  const assetResult = await engine.artifacts.create(
    "vid",
    generationLabel(modelSlug("kie", apiModel), common.prompt),
  );
  if (!assetResult.ok) {
    return {
      isError: true as const,
      content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }],
    };
  }

  const { artifactId: vidAssetId, path: vidAssetDir } = assetResult.value;
  const jobId = `${modelSlug("kie", apiModel)}-${vidAssetId}-${Date.now()}`;
  await queue.enqueue(jobId, {
    type: KLING_OMNI_JOB_TYPE,
    mode,
    vidAssetId,
    vidAssetDir,
    bookId: common.book_id,
    prompt: common.prompt,
    imageInputs: imageResult.value,
    videoInputs: videoResult.value,
    sourceImageIds: imageResult.value.map((input) => input.assetId),
    sourceVideoIds: videoResult.value.map((input) => input.assetId),
    ...(common.audio !== undefined ? { audio: common.audio } : {}),
    ...(common.resolution !== undefined ? { resolution: common.resolution } : {}),
    ...(common.aspect_ratio !== undefined ? { aspect_ratio: common.aspect_ratio } : {}),
    ...(common.duration !== undefined && common.duration !== ""
      ? { duration: common.duration }
      : {}),
    ...(common.customize_multi_shots !== undefined
      ? { customize_multi_shots: common.customize_multi_shots }
      : {}),
    ...(common.prefer_multi_shots !== undefined
      ? { prefer_multi_shots: common.prefer_multi_shots }
      : {}),
    ...(common.multi_prompt && common.multi_prompt.length > 0
      ? { multi_prompt: common.multi_prompt }
      : {}),
  } as unknown as Record<string, unknown>);

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        vid_asset_id: vidAssetId,
        source_images: imageResult.value.map((input) => input.assetId),
        source_videos: videoResult.value.map((input) => input.assetId),
        job_id: jobId,
        status: "enqueued",
      }),
    }],
  };
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asResolution(value: unknown): OmniCommon["resolution"] {
  return value === "720p" || value === "1080p" || value === "4k" ? value : undefined;
}

function asAspectRatio(value: unknown): OmniCommon["aspect_ratio"] {
  return value === "16:9" || value === "9:16" || value === "1:1" || value === "auto"
    ? value
    : undefined;
}

function asMultiPrompt(value: unknown): OmniCommon["multi_prompt"] {
  if (!Array.isArray(value)) return undefined;
  const shots = value.filter((shot): shot is { prompt: string; duration: number } =>
    shot !== null
    && typeof shot === "object"
    && typeof (shot as { prompt?: unknown }).prompt === "string"
    && typeof (shot as { duration?: unknown }).duration === "number");
  return shots.length > 0 ? shots : undefined;
}

function commonFrom(args: Record<string, unknown>): OmniCommon {
  const bookId = args.book_id;
  const prompt = args.prompt;
  const audio = asBoolean(args.audio);
  const resolution = asResolution(args.resolution);
  const aspectRatio = asAspectRatio(args.aspect_ratio);
  const customize = asBoolean(args.customize_multi_shots);
  const prefer = asBoolean(args.prefer_multi_shots);
  const multiPrompt = asMultiPrompt(args.multi_prompt);
  return {
    book_id: typeof bookId === "string" ? bookId : "",
    prompt: typeof prompt === "string" ? prompt : "",
    ...(audio !== undefined ? { audio } : {}),
    ...(resolution !== undefined ? { resolution } : {}),
    ...(aspectRatio !== undefined ? { aspect_ratio: aspectRatio } : {}),
    ...(args.duration !== undefined ? { duration: args.duration } : {}),
    ...(customize !== undefined ? { customize_multi_shots: customize } : {}),
    ...(prefer !== undefined ? { prefer_multi_shots: prefer } : {}),
    ...(multiPrompt !== undefined ? { multi_prompt: multiPrompt } : {}),
  };
}

export function generateKlingOmniTextToVideoDef(engine: Engine): ToolDef {
  return {
    name: KLING_OMNI_TEXT_TO_VIDEO_TOOL,
    description: "Generate a video using Kling 3.0 Omni text-to-video (KIE). Prompt-only generation at 720p, 1080p, or 4k with optional native audio and multi-shot controls. Creates a new video artifact and enqueues a background job.",
    schema: textSchema,
    handler: async (args) => {
      const parsed = args as TextArgs;
      return enqueueOmni(engine, "text", commonFrom(parsed as Record<string, unknown>), [], []);
    },
  };
}

export function generateKlingOmniImageToVideoDef(engine: Engine): ToolDef {
  return {
    name: KLING_OMNI_IMAGE_TO_VIDEO_TOOL,
    description: "Generate a video using Kling 3.0 Omni image-to-video (KIE). Requires one first-frame image, or first and last frames. Creates a new video artifact and enqueues a background job.",
    schema: imageSchema,
    handler: async (args) => {
      const parsed = args as ImageArgs;
      return enqueueOmni(
        engine,
        "image",
        commonFrom(parsed as Record<string, unknown>),
        nonBlank(parsed.image_refs),
        [],
      );
    },
  };
}

export function generateKlingOmniReferenceToVideoDef(engine: Engine): ToolDef {
  return {
    name: KLING_OMNI_REFERENCE_TO_VIDEO_TOOL,
    description: "Generate a video using Kling 3.0 Omni reference-to-video (KIE). Requires at least one reference image or one reference video. Creates a new video artifact and enqueues a background job.",
    schema: referenceSchema,
    handler: async (args) => {
      const parsed = args as ReferenceArgs;
      return enqueueOmni(
        engine,
        "reference",
        commonFrom(parsed as Record<string, unknown>),
        nonBlank(parsed.image_refs),
        nonBlank(parsed.video_refs),
      );
    },
  };
}

export function generateKlingOmniTransformationDef(engine: Engine): ToolDef {
  return {
    name: KLING_OMNI_TRANSFORMATION_TOOL,
    description: "Generate a video using Kling 3.0 Omni transformation (KIE). Transfers motion from a source video onto optional character images. Creates a new video artifact and enqueues a background job.",
    schema: transformationSchema,
    handler: async (args) => {
      const parsed = args as TransformationArgs;
      return enqueueOmni(
        engine,
        "transformation",
        commonFrom(parsed as Record<string, unknown>),
        nonBlank(parsed.image_refs),
        nonBlank(parsed.video_refs),
      );
    },
  };
}

import { currentBookContext } from "../book-context.js";
import { z } from "zod";
import type { Engine } from "videobook-engine";
import { queue } from "../queue.js";
import { generationLabel } from "../artifact-label.js";
import { previewPlaceholderUrl } from "../preview-payload.js";
import { resolveModel, UnknownModelError } from "../media/descriptor.js";
import { buildWireRequest } from "../media/request.js";
import { checkSeedanceEditSource, checkInsertVideoTiming, checkRefDurations, checkRefs, normalizeRefs } from "../media/refs.js";
import { resolveGenerationSource } from "../media/generation-source.js";
import { PROVIDER_ENV_KEYS } from "../media/adapters/index.js";
import { listModels, modelListing } from "../media/listing.js";
import { OPERATIONS_BY_MEDIA, REF_ROLES, type Media, type MediaRefs, type Operation, type ResolvedModel } from "../media/types.js";
import type { GenerateMediaJob } from "../jobs/generate-media.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

const ARTIFACT_KIND: Record<Media, "img" | "vid" | "aud"> = { image: "img", video: "vid", audio: "aud" };

const OPERATIONS = [
  ...OPERATIONS_BY_MEDIA.image,
  ...OPERATIONS_BY_MEDIA.video,
  ...OPERATIONS_BY_MEDIA.audio,
] as const satisfies readonly Operation[];

const refList = z.union([z.string(), z.array(z.string())]).optional();

function refsSchema() {
  return z.object({
    image: refList.describe("Reference images: artifact ids, @grid addresses resolved to ids, or https URLs"),
    first_frame: refList.describe("First frame image"),
    last_frame: refList.describe("Last frame image"),
    video: refList.describe("Reference or source videos"),
    audio: refList.describe("Reference or driving audio"),
  }).optional().describe("Media inputs by role; each model accepts the roles list_generation_models reports");
}

function toolError(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function textResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function placeholderRefs(refs: MediaRefs): MediaRefs {
  const placeholders: MediaRefs = {};
  for (const role of REF_ROLES) {
    const list = refs[role];
    if (list) placeholders[role] = list.map((ref) => ref.startsWith("http") ? ref : previewPlaceholderUrl(ref));
  }
  return placeholders;
}

function resolveFor(media: Media, raw: unknown): ResolvedModel | string {
  if (typeof raw !== "string" || raw.trim() === "") return "model is required; call list_generation_models";
  try {
    const model = resolveModel(raw.trim());
    return model.media === media ? model : `${model.id} generates ${model.media}, not ${media}`;
  } catch (error) {
    return error instanceof UnknownModelError ? error.message : String(error);
  }
}

function checkOperation(model: ResolvedModel, operation: unknown): string | null {
  if (typeof operation !== "string" || operation === "") return null;
  return model.entry.operations.includes(operation as Operation)
    ? null
    : `${model.id} does not support ${operation}; it supports ${model.entry.operations.join(", ")}`;
}

function optionsOf(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

function optionalString(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() !== "" ? raw : undefined;
}

async function validate(engine: Engine, model: ResolvedModel, args: Record<string, unknown>, refs: MediaRefs): Promise<string | null> {
  const envKey = PROVIDER_ENV_KEYS[model.provider];
  if (!process.env[envKey]) return `${envKey} environment variable is not set`;
  const operationError = checkOperation(model, args.operation);
  if (operationError) return operationError;
  const source = await resolveGenerationSource(engine, model, refs);
  if (!source.ok) return source.error;
  const built = buildWireRequest(model, {
    prompt: optionalString(args.prompt),
    refUrls: placeholderRefs(source.refs),
    options: { ...optionsOf(args.options), ...source.options },
    mode: optionalString(args.mode),
  });
  if (!built.ok) return built.error;
  return (await checkRefs(engine, refs))
    ?? (await checkInsertVideoTiming(engine, model, refs, optionsOf(args.options)))
    ?? (await checkSeedanceEditSource(engine, model, refs, args.mode))
    ?? checkRefDurations(engine, model, refs);
}

async function enqueueGeneration(engine: Engine, model: ResolvedModel, args: Record<string, unknown>, refs: MediaRefs): Promise<ToolResult> {
  const prompt = optionalString(args.prompt);
  const created = await engine.artifacts.create(ARTIFACT_KIND[model.media], generationLabel(model.title, prompt));
  if (!created.ok) return toolError(`Failed to create ${model.media} asset: ${created.error.message}`);
  const { artifactId, path } = created.value;
  const jobId = `generate-${model.media}-${artifactId}-${Date.now()}`;
  const job: GenerateMediaJob = {
    type: "generate_media",
    runId: currentBookContext()?.runId,
    generationId: currentBookContext()?.attemptId,
    model: model.id,
    bookId: String(args.book_id),
    assetId: artifactId,
    assetDir: path,
    ...(prompt !== undefined ? { prompt } : {}),
    refs,
    options: optionsOf(args.options),
    ...(optionalString(args.mode) ? { mode: optionalString(args.mode)! } : {}),
    ...(optionalString(args.replace_audio_with) ? { replaceAudioWith: optionalString(args.replace_audio_with)! } : {}),
  };
  await queue.enqueue(jobId, job);
  return textResult({ asset_id: artifactId, job_id: jobId, model: model.id, status: "enqueued" });
}

function generateDef(engine: Engine, media: Media): ToolDef {
  return {
    name: `generate_${media}`,
    description: `Generate ${media === "audio" ? "audio (speech, dialogue, music, sound effects)" : media === "image" ? "an image" : "a video"} with any catalog model. `
      + "Pick a model id from list_generation_models; options are validated against that model's apicity schema and omitted options use apicity defaults.",
    schema: {
      book_id: z.string().describe("Book id"),
      model: z.string().describe("Model id such as kie:nano-banana-2-1 or fal:fal-ai/nano-banana-pro; see list_generation_models"),
      prompt: z.string().optional().describe("Prompt; name inputs as @image1, @video1, @audio1, @firstframe or @lastframe"),
      refs: refsSchema(),
      mode: z.string().optional().describe("Input mode id for models with several (for example i2v or r2v)"),
      operation: z.enum(OPERATIONS_BY_MEDIA[media]).optional().describe("Optional check that the model supports this operation"),
      options: z.record(z.string(), z.unknown()).optional().describe("Model options from list_generation_models"),
      ...(media === "video" ? { replace_audio_with: z.string().optional().describe("Audio artifact to splice over the generated video") } : {}),
    },
    handler: async (args) => {
      const model = resolveFor(media, args.model);
      if (typeof model === "string") return toolError(model);
      const refs = normalizeRefs(args.refs);
      const invalid = await validate(engine, model, args, refs);
      if (invalid) return toolError(invalid);
      return enqueueGeneration(engine, model, args, refs);
    },
  };
}

function listDef(): ToolDef {
  return {
    name: "list_generation_models",
    description: "List the image, video and audio generation models with their input roles, modes and options, read from apicity",
    scope: "global",
    annotations: { readOnlyHint: true },
    schema: {
      media: z.enum(["image", "video", "audio"]).optional().describe("Only models that generate this media"),
      operation: z.enum(OPERATIONS).optional().describe("Only models that support this operation"),
      include_hidden: z.boolean().optional().describe("Include provider variants hidden from the picker"),
    },
    handler: async (args) => {
      const models = listModels({
        ...(typeof args.media === "string" ? { media: args.media as Media } : {}),
        ...(typeof args.operation === "string" ? { operation: args.operation as Operation } : {}),
        includeHidden: args.include_hidden === true,
      });
      return textResult({ models: models.map(modelListing) });
    },
  };
}

export function generateMediaDefs(engine: Engine): ToolDef[] {
  return [generateDef(engine, "image"), generateDef(engine, "video"), generateDef(engine, "audio"), listDef()];
}

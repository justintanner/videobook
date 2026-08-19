import {
  createKie,
  submitMediaJob,
  type GrokImagineImage2ImageEditRequest,
  type KieProvider,
  type SeedreamProImageToImageRequest,
  type SeedreamProLayerDecompositionRequest,
} from "@apicity/kie";
import {
  GrokImagineImage2ImageEditRequestSchema,
  GrokImagineImage2SegmentMapRequestSchema,
  SeedreamProImageToImageRequestSchema,
  SeedreamProLayerDecompositionRequestSchema,
} from "@apicity/kie/zod";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import type { Engine, Job } from "videobook-engine";
import { requireApiKey } from "../api-key.js";
import {
  IMAGE_SUBJECT_MAP_VERSION,
  applyGrokSegmentsToSubjects,
  composeImageSubjectRemoval,
  exactEditMaskIndexes,
  grokMaskIndex,
  parseGrokSegmentMapResult,
  persistSeedreamSubjectLayers,
  readImageSubjectMapRecord,
  resolveImageSubjectSource,
  subjectAnalysisProviderFailureMessage,
  writeCurrentImageSubjectAnalysisRecord,
  type ImageSubjectMapReadyV1,
  type ImageSubjectNormalizedBox,
  type SeedreamLayerInput,
} from "../image-subject-map.js";
import { cropToFill } from "../image.js";
import { mutateNotebook } from "../notebook-mutations.js";
import { registerJobHandler } from "../queue.js";
import { ensurePaygateSecret, mintKieOtp } from "./kie-paygate.js";

type AnalyzeImageSubjectsPayload = {
  type: "analyze_image_subjects";
  sourceArtifactId: string;
  sourceObjectHash: string;
  bookId: string;
  jobId: string;
  resumeTaskId?: string;
};

type GenerateImageSubjectEditPayload = {
  type: "generate_image_subject_edit";
  imageAssetId: string;
  sourceArtifactId: string;
  sourceObjectHash: string;
  subjectIds: string[];
  operation: "remove" | "edit";
  prompt?: string;
  bookId: string;
  notebookId: string;
  producerCellId: string;
  outputCellId: string;
  generationId?: string;
  jobId: string;
};

type KieLayerResult = {
  baseUrl: string;
  layers: SeedreamLayerInput[];
};

type StoredImageSubjectEditTask = {
  request: SeedreamProImageToImageRequest | GrokImagineImage2ImageEditRequest;
  taskId: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizedBox(value: unknown): ImageSubjectNormalizedBox | undefined {
  const values = Array.isArray(value) ? value.map(numberValue) : null;
  if (values?.length === 4 && values.every((entry): entry is number => entry !== null)) {
    const [x1, y1, x2, y2] = values;
    const scale = values.some((entry) => entry > 1) ? 1000 : 1;
    if (values.some((entry) => entry < 0 || entry > scale)) return undefined;
    if (scale === 1000 && values.some((entry) => !Number.isInteger(entry))) {
      return undefined;
    }
    const x = x1 / scale;
    const y = y1 / scale;
    const right = x2 / scale;
    const bottom = y2 / scale;
    if (right > x && bottom > y) {
      return { x, y, width: right - x, height: bottom - y };
    }
  }
  const object = record(value);
  if (!object) return undefined;
  const xValue = numberValue(object.x ?? object.left);
  const yValue = numberValue(object.y ?? object.top);
  const widthValue = numberValue(object.width ?? object.w);
  const heightValue = numberValue(object.height ?? object.h);
  if (xValue === null || yValue === null || widthValue === null || heightValue === null) {
    return undefined;
  }
  const raw = [xValue, yValue, widthValue, heightValue];
  const scale = raw.some((entry) => entry > 1) ? 1000 : 1;
  if (raw.some((entry) => entry < 0 || entry > scale)) return undefined;
  if (scale === 1000 && raw.some((entry) => !Number.isInteger(entry))) {
    return undefined;
  }
  const x = xValue / scale;
  const y = yValue / scale;
  const width = widthValue / scale;
  const height = heightValue / scale;
  if (width <= 0 || height <= 0 || x + width > 1.001 || y + height > 1.001) {
    return undefined;
  }
  return { x, y, width, height };
}

function layerBox(value: Record<string, unknown>): ImageSubjectNormalizedBox | undefined {
  const boundingBox = record(value.bounding_box ?? value.boundingBox);
  return normalizedBox(
    boundingBox?.normalized
      ?? boundingBox?.normalized_box
      ?? value.normalized_box
      ?? value.normalizedBox,
  );
}

function layerArray(value: Record<string, unknown>): unknown[] | null {
  for (const candidate of [
    value.layers_data,
    value.layersData,
    record(value.resultObject)?.layers_data,
    record(value.resultObject)?.layersData,
    record(value.result)?.layers_data,
    record(value.result)?.layersData,
    record(value.data)?.layers_data,
    record(value.data)?.layersData,
  ]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return null;
}

export function parseSeedreamLayerResult(resultJson: string): KieLayerResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    throw new Error("Seedream returned invalid result JSON");
  }
  const root = record(parsed);
  if (!root) throw new Error("Seedream returned an invalid layer result");
  const entries = layerArray(root)?.flatMap((value) => {
    const item = record(value);
    const url = item ? stringValue(item.url ?? item.layer_url ?? item.layerUrl) : null;
    if (!item || !url) return [];
    return [{ item, url }];
  }) ?? [];
  if (entries.length === 0) {
    throw new Error("Seedream layer decomposition returned no downloadable layers");
  }
  const ordered = entries.sort((left, right) =>
    (numberValue(left.item.z_index ?? left.item.zIndex) ?? 0)
      - (numberValue(right.item.z_index ?? right.item.zIndex) ?? 0));
  const baseIndex = ordered.findIndex(({ item }) =>
    !stringValue(item.name ?? item.label) && !layerBox(item));
  if (baseIndex < 0) {
    throw new Error("Seedream layer decomposition returned no identifiable base layer");
  }
  const base = ordered[baseIndex]!;
  const layers = ordered.flatMap(({ item, url }, index): SeedreamLayerInput[] => {
    if (index === baseIndex) return [];
    const zIndex = Math.round(numberValue(item.z_index ?? item.zIndex) ?? index);
    const box = layerBox(item);
    return [{
      url,
      zIndex,
      ...(stringValue(item.name ?? item.label)
        ? { name: stringValue(item.name ?? item.label)! }
        : {}),
      ...(stringValue(item.description)
        ? { description: stringValue(item.description)! }
        : {}),
      ...(box ? { normalizedBox: box } : {}),
    }];
  });
  return { baseUrl: base.url, layers };
}

export function seedreamLayerDecompositionRequest(
  imageUrl: string,
): SeedreamProLayerDecompositionRequest {
  return SeedreamProLayerDecompositionRequestSchema.parse({
    model: "seedream/5-pro-layer-decomposition",
    input: {
      image_url: imageUrl,
      size: "auto",
      output_format: "jpeg",
    },
  });
}

function parseResultUrls(resultJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    throw new Error("Seedream returned invalid result JSON");
  }
  const root = record(parsed);
  if (!root) throw new Error("Seedream returned an invalid image result");
  for (const value of [
    root.resultUrls,
    root.result_urls,
    record(root.resultObject)?.resultUrls,
    record(root.resultObject)?.result_urls,
    record(root.result)?.resultUrls,
    record(root.result)?.result_urls,
  ]) {
    if (!Array.isArray(value)) continue;
    const urls = value.flatMap((entry) => stringValue(entry) ?? []);
    if (urls.length > 0) return urls;
  }
  throw new Error("Seedream image edit returned no downloadable images");
}

function closestAspectRatio(
  width: number,
  height: number,
): SeedreamProImageToImageRequest["input"]["aspect_ratio"] {
  const target = width / height;
  const candidates = [
    ["1:1", 1],
    ["4:3", 4 / 3],
    ["3:4", 3 / 4],
    ["16:9", 16 / 9],
    ["9:16", 9 / 16],
    ["2:3", 2 / 3],
    ["3:2", 3 / 2],
  ] as const;
  return candidates.reduce((best, candidate) =>
    Math.abs(candidate[1] - target) < Math.abs(best[1] - target)
      ? candidate
      : best)[0];
}

function semanticEditPrompt(
  map: ImageSubjectMapReadyV1,
  subjectIds: readonly string[],
  prompt: string,
): string {
  const selected = new Set(subjectIds);
  const targets = map.subjects
    .filter((subject) => selected.has(subject.id))
    .map((subject) => {
      const box = subject.normalizedBox;
      return `${subject.label} at normalized box ${box.x.toFixed(4)},${box.y.toFixed(4)},${box.width.toFixed(4)},${box.height.toFixed(4)}`;
    });
  return `${prompt.trim()}\nModify only these selected subjects: ${targets.join("; ")}. Preserve every unselected person, object, background element, composition, and camera framing.`;
}

function kieProvider(): KieProvider {
  return createKie({
    apiKey: requireApiKey("KIE_API_KEY"),
    timeout: 60_000,
    paygate: { secret: ensurePaygateSecret() },
  });
}

const KIE_RESULT_TIMEOUT_MS = 25 * 60_000;

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(
    typeof signal.reason === "string" ? signal.reason : "Operation aborted",
  );
  error.name = "AbortError";
  return error;
}

function waitForOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  deadlineAt: number,
  timeoutError: Error,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return Promise.reject(timeoutError);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const resolveOnce = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (cause: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(cause);
    };
    const onAbort = () => rejectOnce(abortReason(signal));
    const timer = setTimeout(() => rejectOnce(timeoutError), remaining);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    void operation.then(resolveOnce, rejectOnce);
  });
}

export function imageSubjectAnalysisDeadline(
  startedAt: string,
  fallbackNow = Date.now(),
): number {
  const parsed = Date.parse(startedAt);
  return (Number.isFinite(parsed) ? parsed : fallbackNow) + KIE_RESULT_TIMEOUT_MS;
}

type KieResultContext = "subject-analysis" | "subject-edit";

function kieResultFailureMessage(
  context: KieResultContext,
  message: string | null,
  code: string | null,
): string {
  if (context === "subject-analysis") {
    return subjectAnalysisProviderFailureMessage(message, code);
  }
  const detail = message || code || "Unknown provider error";
  const codeDetail = code && code !== detail ? ` (${code})` : "";
  return `Image subject edit provider failed: ${detail}${codeDetail}`;
}

async function waitForKieResult(
  provider: KieProvider,
  taskId: string,
  signal: AbortSignal,
  deadlineAt: number,
  context: KieResultContext,
): Promise<string> {
  const timeoutError = context === "subject-analysis"
    ? new Error("Subject analysis did not finish within 25 minutes. Retry the analysis.")
    : new Error(`Kie task ${taskId} did not finish within 25 minutes`);
  while (Date.now() < deadlineAt) {
    const result = await waitForOperation(
      provider.get.api.v1.jobs.recordInfo(taskId),
      signal,
      deadlineAt,
      timeoutError,
    );
    const state = result.data?.state?.toLowerCase();
    if (state === "success") {
      if (!result.data?.resultJson) {
        throw new Error("Kie task succeeded without result JSON");
      }
      return result.data.resultJson;
    }
    if (state === "fail" || state === "failed") {
      throw new Error(kieResultFailureMessage(
        context,
        stringValue(result.data?.failMsg),
        stringValue(result.data?.failCode),
      ));
    }
    await delay(Math.min(3_000, Math.max(1, deadlineAt - Date.now())), undefined, {
      signal,
    });
  }
  throw timeoutError;
}

async function writeAnalysisFailure(
  engine: Engine,
  payload: AnalyzeImageSubjectsPayload,
  dimensions: { width: number; height: number },
  error: string,
  taskId?: string,
): Promise<boolean> {
  return await writeCurrentImageSubjectAnalysisRecord(engine, {
    version: IMAGE_SUBJECT_MAP_VERSION,
    status: "failed",
    artifactId: payload.sourceArtifactId,
    objectHash: payload.sourceObjectHash,
    width: dimensions.width,
    height: dimensions.height,
    jobId: payload.jobId,
    error,
    failedAt: new Date().toISOString(),
    ...(taskId ? { taskId } : {}),
  });
}

function withoutInputError(
  inputs: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const next = { ...(inputs ?? {}) };
  delete next.error;
  return next;
}

async function updateNotebookEditState(
  engine: Engine,
  payload: GenerateImageSubjectEditPayload,
  state: "completed" | "error",
  error?: string,
): Promise<void> {
  const updatedAt = new Date().toISOString();
  const result = await mutateNotebook(
    engine,
    payload.notebookId,
    state === "completed" ? "complete_image_subject_edit" : "fail_image_subject_edit",
    (notebook) => ({
      ...notebook,
      cells: notebook.cells.map((cell) => {
        if (cell.id === payload.producerCellId) {
          return {
            ...cell,
            inputs: {
              ...withoutInputError(cell.inputs),
              state,
              ...(error ? { error } : {}),
            },
          };
        }
        if (cell.id === payload.outputCellId) {
          return {
            ...cell,
            ...(state === "completed"
              ? { outputArtifactId: payload.imageAssetId }
              : {}),
            inputs: {
              ...withoutInputError(cell.inputs),
              state,
              ...(state === "completed"
                ? { outputVersionArtifactIds: [payload.imageAssetId] }
                : {}),
              ...(error ? { error } : {}),
            },
          };
        }
        return cell;
      }),
      execution: {
        ...(notebook.execution ?? {}),
        [payload.producerCellId]: {
          status: state,
          outputArtifactId: payload.imageAssetId,
          providerArtifactId: payload.imageAssetId,
          runId: payload.jobId,
          completedAt: updatedAt,
          updatedAt,
          tool: "edit_image_subjects",
          ...(error ? { error } : {}),
        },
        [payload.outputCellId]: {
          status: state,
          outputArtifactId: payload.imageAssetId,
          runId: payload.jobId,
          completedAt: updatedAt,
          updatedAt,
          tool: "edit_image_subjects",
          ...(error ? { error } : {}),
        },
      },
    }),
    {
      sourceArtifactId: payload.sourceArtifactId,
      outputArtifactId: payload.imageAssetId,
      subjectIds: payload.subjectIds,
      state,
      ...(error ? { error } : {}),
    },
    { artifactId: payload.imageAssetId },
  );
  if (!result.ok) throw new Error(result.error.message);
}

async function updateNotebookEditProgress(
  engine: Engine,
  payload: GenerateImageSubjectEditPayload,
  status: "running" | "awaiting_provider",
): Promise<void> {
  const updatedAt = new Date().toISOString();
  const inputState = status === "awaiting_provider" ? "awaiting-output" : "working";
  const result = await mutateNotebook(
    engine,
    payload.notebookId,
    "progress_image_subject_edit",
    (notebook) => {
      const producerExecution = {
        ...(notebook.execution?.[payload.producerCellId] ?? {}),
      };
      const outputExecution = {
        ...(notebook.execution?.[payload.outputCellId] ?? {}),
      };
      delete producerExecution.error;
      delete producerExecution.completedAt;
      delete outputExecution.error;
      delete outputExecution.completedAt;
      return {
        ...notebook,
        cells: notebook.cells.map((cell) =>
          cell.id === payload.producerCellId || cell.id === payload.outputCellId
            ? {
                ...cell,
                inputs: {
                  ...withoutInputError(cell.inputs),
                  state: inputState,
                },
              }
            : cell),
        execution: {
          ...(notebook.execution ?? {}),
          [payload.producerCellId]: {
            ...producerExecution,
            status,
            outputArtifactId: payload.imageAssetId,
            providerArtifactId: payload.imageAssetId,
            runId: payload.jobId,
            updatedAt,
            tool: "edit_image_subjects",
          },
          [payload.outputCellId]: {
            ...outputExecution,
            status,
            outputArtifactId: payload.imageAssetId,
            runId: payload.jobId,
            updatedAt,
            tool: "edit_image_subjects",
          },
        },
      };
    },
    {
      outputArtifactId: payload.imageAssetId,
      status,
    },
    { artifactId: payload.imageAssetId },
  );
  if (!result.ok) throw new Error(result.error.message);
}

async function persistProcessedImage(
  engine: Engine,
  payload: GenerateImageSubjectEditPayload,
  map: ImageSubjectMapReadyV1,
  output: Buffer,
  provenance: Record<string, unknown>,
): Promise<void> {
  const outputMetadata = await sharp(output).metadata();
  const width = outputMetadata.width;
  const height = outputMetadata.height;
  if (!width || !height) throw new Error("Could not determine edited image dimensions");
  const [landscape, portrait, square] = await Promise.all([
    cropToFill(output, 1920, 1080),
    cropToFill(output, 1080, 1920),
    cropToFill(output, 1080, 1080),
  ]);
  const writes = await Promise.all([
    engine.files.write(payload.imageAssetId, "original.png", output),
    engine.files.write(payload.imageAssetId, "landscape.jpg", landscape),
    engine.files.write(payload.imageAssetId, "portrait.jpg", portrait),
    engine.files.write(payload.imageAssetId, "square.jpg", square),
  ]);
  const failed = writes.find((result) => !result.ok);
  if (failed && !failed.ok) throw new Error(failed.error.message);
  const metadata = await engine.metadata.artifacts.write(
    payload.imageAssetId,
    "original",
    {
      origin: "image_subject_remove",
      source_asset: payload.sourceArtifactId,
      source_object_hash: payload.sourceObjectHash,
      subject_map_version: IMAGE_SUBJECT_MAP_VERSION,
      subject_analysis_id: map.analysisId,
      selected_subject_ids: payload.subjectIds,
      ...(payload.prompt ? { prompt: payload.prompt } : {}),
      ...provenance,
      width,
      height,
      generated_at: new Date().toISOString(),
    },
  );
  if (!metadata.ok) throw new Error(metadata.error.message);
}

export async function readStoredImageSubjectEditTask(
  engine: Engine,
  imageAssetId: string,
): Promise<StoredImageSubjectEditTask | null> {
  const storedRequest = await engine.metadata.artifacts.read<unknown>(
    imageAssetId,
    "generation-payload",
  );
  const parsedRequest = storedRequest.ok
    ? SeedreamProImageToImageRequestSchema.safeParse(storedRequest.value)
    : null;
  const parsedExact = storedRequest.ok && !parsedRequest?.success
    ? GrokImagineImage2ImageEditRequestSchema.safeParse(storedRequest.value)
    : null;
  const storedTask = await engine.metadata.artifacts.read<unknown>(
    imageAssetId,
    "kie-task-id",
  );
  const taskRecord = storedTask.ok ? record(storedTask.value) : null;
  const taskId = stringValue(taskRecord?.taskId);
  const request = parsedRequest?.success
    ? parsedRequest.data
    : parsedExact?.success
      ? parsedExact.data
      : null;
  if (taskId && !request) {
    throw new Error("Stored Kie subject edit task has no valid generation payload");
  }
  return taskId && request
    ? { request, taskId }
    : null;
}

const GROK_IMAGE_2_SOURCE_MODELS = new Set([
  "grok-imagine-image-2-0/text-to-image",
  "grok-imagine-image-2-0/image-edit",
]);

export async function readGrokImagineImage2SourceTaskId(
  engine: Engine,
  artifactId: string,
): Promise<string | null> {
  const payload = await engine.metadata.artifacts.read<unknown>(
    artifactId,
    "generation-payload",
  );
  const model = payload.ok ? record(payload.value)?.model : undefined;
  if (typeof model !== "string" || !GROK_IMAGE_2_SOURCE_MODELS.has(model)) {
    return null;
  }
  const stored = await engine.metadata.artifacts.read<unknown>(
    artifactId,
    "kie-task-id",
  );
  const taskId = stored.ok ? stringValue(record(stored.value)?.taskId) : null;
  return taskId;
}

export function imageSubjectEditRoute(
  map: ImageSubjectMapReadyV1,
  subjectIds: readonly string[],
): "exact" | "semantic" {
  if (!map.grokSourceTaskId) return "semantic";
  return exactEditMaskIndexes(map.subjects, subjectIds) ? "exact" : "semantic";
}

export function grokImagineImage2EditRequest(
  sourceTaskId: string,
  prompt: string,
  maskIndexes: readonly number[],
): GrokImagineImage2ImageEditRequest {
  const mask_indexs = maskIndexes.filter((index) => grokMaskIndex(index) !== undefined);
  if (mask_indexs.length === 0) {
    throw new Error("Exact Grok mask edit requires mask indexes of 1 or greater");
  }
  return GrokImagineImage2ImageEditRequestSchema.parse({
    model: "grok-imagine-image-2-0/image-edit",
    input: {
      prompt,
      task_id: sourceTaskId,
      mask_indexs,
    },
  });
}

async function generateSemanticSubjectEdit(
  engine: Engine,
  payload: GenerateImageSubjectEditPayload,
  map: ImageSubjectMapReadyV1,
  sourceFilename: string,
  signal: AbortSignal,
): Promise<{ output: Buffer; taskId: string; request: SeedreamProImageToImageRequest }> {
  const stored = await readStoredImageSubjectEditTask(engine, payload.imageAssetId);
  const storedSemantic = stored?.request.model === "seedream/5-pro-image-to-image"
    ? stored
    : null;
  let request = storedSemantic?.request as SeedreamProImageToImageRequest | null ?? null;
  let taskId = storedSemantic?.taskId ?? null;
  const provider = kieProvider();
  if (!request || !taskId) {
    const { uploadAssetToKie } = await import("./_kie-upload.js");
    const imageUrl = await uploadAssetToKie(
      engine,
      payload.sourceArtifactId,
      sourceFilename,
    );
    const prompt = semanticEditPrompt(map, payload.subjectIds, payload.prompt ?? "");
    request = SeedreamProImageToImageRequestSchema.parse({
      model: "seedream/5-pro-image-to-image",
      input: {
        image_urls: [imageUrl],
        prompt,
        aspect_ratio: closestAspectRatio(map.width, map.height),
        quality: "basic",
        output_format: "png",
        nsfw_checker: false,
      },
    });
    const metadata = await engine.metadata.artifacts.write(
      payload.imageAssetId,
      "generation-payload",
      request,
    );
    if (!metadata.ok) throw new Error(metadata.error.message);
    taskId = await submitMediaJob(provider, request, {
      otp: mintKieOtp(request),
    });
    const taskMetadata = await engine.metadata.artifacts.write(
      payload.imageAssetId,
      "kie-task-id",
      { taskId },
    );
    if (!taskMetadata.ok) throw new Error(taskMetadata.error.message);
  }
  if (payload.generationId) {
    const generation = await engine.generations.update(payload.generationId, {
      status: "awaiting_provider",
      error: null,
    });
    if (!generation.ok) throw new Error(generation.error.message);
  }
  await updateNotebookEditProgress(engine, payload, "awaiting_provider");
  const resultJson = await waitForKieResult(
    provider,
    taskId,
    signal,
    Date.now() + KIE_RESULT_TIMEOUT_MS,
    "subject-edit",
  );
  const [resultUrl] = parseResultUrls(resultJson);
  if (!resultUrl) throw new Error("Seedream image edit returned no image");
  const response = await fetch(resultUrl, { signal });
  if (!response.ok) {
    throw new Error(`Failed to download Seedream edit: ${response.status} ${response.statusText}`);
  }
  return {
    output: await sharp(Buffer.from(await response.arrayBuffer())).png().toBuffer(),
    taskId,
    request,
  };
}

async function downloadResultImages(
  urls: readonly string[],
  signal: AbortSignal,
  label: string,
): Promise<Buffer[]> {
  const images: Buffer[] = [];
  for (const [index, url] of urls.entries()) {
    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new Error(
        `Failed to download ${label} ${index + 1}: ${response.status} ${response.statusText}`,
      );
    }
    images.push(await sharp(Buffer.from(await response.arrayBuffer())).png().toBuffer());
  }
  return images;
}

export async function persistExtraResultImages(
  engine: Engine,
  artifactId: string,
  extras: readonly Buffer[],
): Promise<void> {
  for (const [index, extra] of extras.entries()) {
    const written = await engine.files.write(
      artifactId,
      `result-${index + 2}.png`,
      extra,
    );
    if (!written.ok) throw new Error(written.error.message);
  }
}

async function generateExactSubjectEdit(
  engine: Engine,
  payload: GenerateImageSubjectEditPayload,
  map: ImageSubjectMapReadyV1,
  signal: AbortSignal,
): Promise<{
  output: Buffer;
  extras: Buffer[];
  taskId: string;
  request: GrokImagineImage2ImageEditRequest;
}> {
  if (!map.grokSourceTaskId) {
    throw new Error("Exact Grok mask edit requires a Grok Imagine Image 2.0 source task");
  }
  const maskIndexes = exactEditMaskIndexes(map.subjects, payload.subjectIds);
  if (!maskIndexes) {
    throw new Error("Selected subjects are not capability-gated for exact mask edit");
  }
  const stored = await readStoredImageSubjectEditTask(engine, payload.imageAssetId);
  const storedExact = stored?.request.model === "grok-imagine-image-2-0/image-edit"
    ? stored
    : null;
  let request = storedExact?.request as GrokImagineImage2ImageEditRequest | null ?? null;
  let taskId = storedExact?.taskId ?? null;
  const provider = kieProvider();
  if (!request || !taskId) {
    request = grokImagineImage2EditRequest(
      map.grokSourceTaskId,
      payload.prompt ?? "",
      maskIndexes,
    );
    const metadata = await engine.metadata.artifacts.write(
      payload.imageAssetId,
      "generation-payload",
      request,
    );
    if (!metadata.ok) throw new Error(metadata.error.message);
    taskId = await submitMediaJob(provider, request, {
      otp: mintKieOtp(request),
    });
    const taskMetadata = await engine.metadata.artifacts.write(
      payload.imageAssetId,
      "kie-task-id",
      { taskId },
    );
    if (!taskMetadata.ok) throw new Error(taskMetadata.error.message);
  }
  if (payload.generationId) {
    const generation = await engine.generations.update(payload.generationId, {
      status: "awaiting_provider",
      error: null,
    });
    if (!generation.ok) throw new Error(generation.error.message);
  }
  await updateNotebookEditProgress(engine, payload, "awaiting_provider");
  const resultJson = await waitForKieResult(
    provider,
    taskId,
    signal,
    Date.now() + KIE_RESULT_TIMEOUT_MS,
    "subject-edit",
  );
  const urls = parseResultUrls(resultJson);
  const images = await downloadResultImages(urls, signal, "Grok exact edit");
  const [output, ...extras] = images;
  if (!output) throw new Error("Grok image edit returned no image");
  return { output, extras, taskId, request };
}

async function augmentMapWithGrokSegments(
  engine: Engine,
  sourceArtifactId: string,
  map: ImageSubjectMapReadyV1,
  provider: KieProvider,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<ImageSubjectMapReadyV1> {
  const grokSourceTaskId = await readGrokImagineImage2SourceTaskId(
    engine,
    sourceArtifactId,
  );
  if (!grokSourceTaskId) return map;
  try {
    const request = GrokImagineImage2SegmentMapRequestSchema.parse({
      model: "grok-imagine-image-2-0/segment-map",
      input: { task_id: grokSourceTaskId },
    });
    const segmentTaskId = await submitMediaJob(provider, request, {
      otp: mintKieOtp(request),
    });
    const resultJson = await waitForKieResult(
      provider,
      segmentTaskId,
      signal,
      deadlineAt,
      "subject-analysis",
    );
    return {
      ...map,
      grokSourceTaskId,
      subjects: applyGrokSegmentsToSubjects(
        map.subjects,
        parseGrokSegmentMapResult(resultJson),
      ),
    };
  } catch {
    return { ...map, grokSourceTaskId };
  }
}

function analyzeImageSubjectsPayload(
  value: Record<string, unknown>,
): AnalyzeImageSubjectsPayload | null {
  if (
    value.type !== "analyze_image_subjects"
    || typeof value.sourceArtifactId !== "string"
    || typeof value.sourceObjectHash !== "string"
    || typeof value.bookId !== "string"
    || typeof value.jobId !== "string"
  ) {
    return null;
  }
  return {
    type: "analyze_image_subjects",
    sourceArtifactId: value.sourceArtifactId,
    sourceObjectHash: value.sourceObjectHash,
    bookId: value.bookId,
    jobId: value.jobId,
    ...(typeof value.resumeTaskId === "string"
      ? { resumeTaskId: value.resumeTaskId }
      : {}),
  };
}

function generateImageSubjectEditPayload(
  value: Record<string, unknown>,
): GenerateImageSubjectEditPayload | null {
  if (
    value.type !== "generate_image_subject_edit"
    || typeof value.imageAssetId !== "string"
    || typeof value.sourceArtifactId !== "string"
    || typeof value.sourceObjectHash !== "string"
    || !Array.isArray(value.subjectIds)
    || !value.subjectIds.every((entry) => typeof entry === "string")
    || (value.operation !== "remove" && value.operation !== "edit")
    || typeof value.bookId !== "string"
    || typeof value.notebookId !== "string"
    || typeof value.producerCellId !== "string"
    || typeof value.outputCellId !== "string"
    || typeof value.jobId !== "string"
  ) {
    return null;
  }
  return {
    type: "generate_image_subject_edit",
    imageAssetId: value.imageAssetId,
    sourceArtifactId: value.sourceArtifactId,
    sourceObjectHash: value.sourceObjectHash,
    subjectIds: value.subjectIds,
    operation: value.operation,
    bookId: value.bookId,
    notebookId: value.notebookId,
    producerCellId: value.producerCellId,
    outputCellId: value.outputCellId,
    jobId: value.jobId,
    ...(typeof value.prompt === "string" ? { prompt: value.prompt } : {}),
    ...(typeof value.generationId === "string"
      ? { generationId: value.generationId }
      : {}),
  };
}

function imageSubjectEditNeedsTerminalization(
  engine: Engine,
  payload: GenerateImageSubjectEditPayload,
): boolean {
  const notebook = engine.notebooks.read(payload.notebookId);
  if (!notebook.ok) return false;
  const cellIds = new Set(notebook.value.cells.map((cell) => cell.id));
  const states = [payload.producerCellId, payload.outputCellId].flatMap((cellId) => {
    if (!cellIds.has(cellId)) return [];
    const state = notebook.value.execution?.[cellId];
    if (!state) return [];
    const matchesRun = state.runId === payload.jobId;
    const matchesLegacy = !state.runId
      && state.tool === "edit_image_subjects"
      && state.outputArtifactId === payload.imageAssetId;
    return matchesRun || matchesLegacy ? [state] : [];
  });
  return states.length > 0 && states.some((state) =>
    state.status !== "completed" && state.status !== "error");
}

function imageSubjectAnalysisTerminalError(job: Job): string {
  if (job.error?.message) return job.error.message;
  if (job.result && typeof job.result === "object" && !Array.isArray(job.result)) {
    const result = job.result as Record<string, unknown>;
    if (typeof result.error === "string" && result.error.trim()) {
      return result.error.trim();
    }
    if (result.success === false && typeof result.message === "string" && result.message.trim()) {
      return result.message.trim();
    }
  }
  return job.state === "done"
    ? "Subject analysis completed without publishing subjects. Retry the analysis."
    : `Subject analysis job ${job.state}`;
}

export async function reconcileImageSubjectJobFailures(
  engine: Engine,
  bookId: string,
): Promise<{ analysesFailed: number; editsFailed: number }> {
  let analysesFailed = 0;
  let editsFailed = 0;
  const analysisTerminalStates = ["failed", "aborted", "done"] as const;
  const analysisJobs = engine.jobs.queue.list({
    states: [...analysisTerminalStates],
    type: "analyze_image_subjects",
  });
  for (const job of analysisJobs) {
    const payload = analyzeImageSubjectsPayload(job.payload);
    if (!payload || payload.bookId !== bookId) continue;
    try {
      const subjectMap = await readImageSubjectMapRecord(
        engine,
        payload.sourceArtifactId,
      );
      if (
        subjectMap?.status !== "analyzing"
        || subjectMap.objectHash !== payload.sourceObjectHash
        || subjectMap.jobId !== payload.jobId
      ) {
        continue;
      }
      const written = await writeAnalysisFailure(
        engine,
        payload,
        { width: subjectMap.width, height: subjectMap.height },
        imageSubjectAnalysisTerminalError(job),
        subjectMap.taskId,
      );
      if (written) analysesFailed += 1;
    } catch {
      continue;
    }
  }
  const editTerminalStates = ["failed", "aborted"] as const;
  const editJobs = engine.jobs.queue.list({
    states: [...editTerminalStates],
    type: "generate_image_subject_edit",
  });
  for (const job of editJobs) {
    const payload = generateImageSubjectEditPayload(job.payload);
    if (
      !payload
      || payload.bookId !== bookId
      || !imageSubjectEditNeedsTerminalization(engine, payload)
    ) {
      continue;
    }
    const message = job.error?.message ?? `Image subject edit job ${job.state}`;
    const terminalized = await updateNotebookEditState(
      engine,
      payload,
      "error",
      message,
    ).then(() => true, () => false);
    if (!terminalized) continue;
    if (payload.generationId) {
      await engine.generations.update(payload.generationId, {
        status: "failed",
        error: message,
      }).catch(() => undefined);
    }
    editsFailed += 1;
  }
  return { analysesFailed, editsFailed };
}

export function registerImageSubjectJobs(engine: Engine): void {
  registerJobHandler("analyze_image_subjects", async (rawPayload, context) => {
    const payload = rawPayload as AnalyzeImageSubjectsPayload;
    let dimensions = { width: 1, height: 1 };
    let taskId: string | undefined;
    try {
      const source = await resolveImageSubjectSource(engine, payload.sourceArtifactId);
      dimensions = { width: source.width, height: source.height };
      if (source.objectHash !== payload.sourceObjectHash) {
        throw new Error("The source image changed before subject analysis started");
      }
      const existing = await readImageSubjectMapRecord(engine, source.artifactId);
      if (
        existing?.status !== "analyzing"
        || existing.objectHash !== source.objectHash
        || existing.jobId !== payload.jobId
      ) {
        throw new Error("Subject analysis was superseded by a newer request");
      }
      const startedAt = existing.startedAt;
      taskId = existing.taskId;
      const deadlineAt = imageSubjectAnalysisDeadline(startedAt);
      if (Date.now() >= deadlineAt) {
        throw new Error("Subject analysis did not finish within 25 minutes. Retry the analysis.");
      }
      const provider = kieProvider();
      if (!taskId) {
        const { uploadAssetToKie } = await import("./_kie-upload.js");
        const imageUrl = await uploadAssetToKie(engine, source.artifactId, source.file.name);
        if (Date.now() >= deadlineAt) {
          throw new Error("Subject analysis did not finish within 25 minutes. Retry the analysis.");
        }
        const request = seedreamLayerDecompositionRequest(imageUrl);
        taskId = await submitMediaJob(provider, request, {
          otp: mintKieOtp(request),
        });
        const recorded = await writeCurrentImageSubjectAnalysisRecord(engine, {
          version: IMAGE_SUBJECT_MAP_VERSION,
          status: "analyzing",
          artifactId: source.artifactId,
          objectHash: source.objectHash,
          width: source.width,
          height: source.height,
          jobId: payload.jobId,
          startedAt,
          taskId,
        });
        if (!recorded) {
          throw new Error("Subject analysis was superseded by a newer request");
        }
      }
      const resultJson = await waitForKieResult(
        provider,
        taskId,
        context.signal,
        deadlineAt,
        "subject-analysis",
      );
      const layerResult = parseSeedreamLayerResult(resultJson);
      const seedreamReady = await persistSeedreamSubjectLayers(engine, source, {
        jobId: payload.jobId,
        taskId,
        ...layerResult,
        signal: context.signal,
      });
      const ready = await augmentMapWithGrokSegments(
        engine,
        source.artifactId,
        seedreamReady,
        provider,
        context.signal,
        deadlineAt,
      );
      const published = await writeCurrentImageSubjectAnalysisRecord(engine, ready);
      if (!published) {
        return {
          success: false,
          superseded: true,
          artifactId: source.artifactId,
          objectHash: source.objectHash,
        };
      }
      return {
        success: true,
        artifactId: source.artifactId,
        objectHash: source.objectHash,
        subjects: ready.subjects.length,
      };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      await writeAnalysisFailure(engine, payload, dimensions, message, taskId).catch(() => undefined);
      throw cause;
    }
  });

  registerJobHandler("generate_image_subject_edit", async (rawPayload, context) => {
    const payload = rawPayload as GenerateImageSubjectEditPayload;
    try {
      const source = await resolveImageSubjectSource(engine, payload.sourceArtifactId);
      if (source.objectHash !== payload.sourceObjectHash) {
        throw new Error("The source image changed before subject editing started");
      }
      const record = await readImageSubjectMapRecord(engine, payload.sourceArtifactId);
      if (!record || record.status !== "ready" || record.objectHash !== source.objectHash) {
        throw new Error("A current subject map is required before editing subjects");
      }
      await updateNotebookEditProgress(engine, payload, "running");
      if (payload.operation === "edit" && !payload.prompt?.trim()) {
        throw new Error("A prompt is required to edit selected subjects");
      }
      if (payload.operation === "remove") {
        const output = await composeImageSubjectRemoval(
          engine,
          payload.sourceArtifactId,
          record,
          payload.subjectIds,
        );
        await persistProcessedImage(engine, payload, record, output, {
          model: "local/sharp-layer-composite",
        });
      } else if (imageSubjectEditRoute(record, payload.subjectIds) === "exact") {
        const generated = await generateExactSubjectEdit(
          engine,
          payload,
          record,
          context.signal,
        );
        await persistProcessedImage(engine, payload, record, generated.output, {
          origin: "image_subject_edit",
          model: generated.request.model,
          kie_task_id: generated.taskId,
          targeting: "exact-mask",
          mask_indexs: generated.request.input.mask_indexs,
        });
        await persistExtraResultImages(
          engine,
          payload.imageAssetId,
          generated.extras,
        );
      } else {
        const generated = await generateSemanticSubjectEdit(
          engine,
          payload,
          record,
          source.file.name,
          context.signal,
        );
        await persistProcessedImage(engine, payload, record, generated.output, {
          origin: "image_subject_edit",
          model: generated.request.model,
          kie_task_id: generated.taskId,
          targeting: "semantic-label-and-box",
        });
      }
      await updateNotebookEditState(engine, payload, "completed");
      if (payload.generationId) {
        const updated = await engine.generations.update(payload.generationId, {
          status: "completed",
          outputArtifactId: payload.imageAssetId,
          error: null,
        });
        if (!updated.ok) throw new Error(updated.error.message);
      }
      return { success: true, imageAssetId: payload.imageAssetId };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      await updateNotebookEditState(engine, payload, "error", message).catch(() => undefined);
      if (payload.generationId) {
        await engine.generations.update(payload.generationId, {
          status: "failed",
          error: message,
        }).catch(() => undefined);
      }
      throw cause;
    }
  });
}

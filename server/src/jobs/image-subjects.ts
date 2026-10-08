import {
  submitMediaJob,
  type GrokImagineImage2ImageEditRequest,
  type KieProvider,
  type SeedreamProLayerDecompositionRequest,
} from "@apicity/kie";
import {
  GrokImagineImage2ImageEditRequestSchema,
  GrokImagineImage2SegmentMapRequestSchema,
  SeedreamProLayerDecompositionRequestSchema,
} from "@apicity/kie/zod";
import sharp from "sharp";
import {
  KIE_RESULT_TIMEOUT_MS,
  kieProvider,
  parseResultUrls,
  waitForKieResult,
} from "./_kie-poll.js";
import {
  GROK_EXACT_MASK_ADAPTER_ID,
  imageEditAdapter,
  IMAGE_EDIT_ADAPTERS,
  type ImageEditAdapter,
  type ImageEditProviderRequest,
} from "./_image-edit-adapter.js";
import { DEFAULT_IMAGE_EDIT_MODEL_ID } from "../image-edit-models.js";
import { compositeImageRegionEdit, imageRegionEditPrompt } from "../image-region-edit.js";
import type { Engine, Job } from "videobook-engine";
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
  writeCurrentImageSubjectAnalysisRecord,
  type ImageSubjectMapReadyV1,
  type ImageSubjectNormalizedBox,
  type ImageSubjectSource,
  type SeedreamLayerInput,
} from "../image-subject-map.js";
import { enqueueSearchIndex } from "./enqueue-search-index.js";
import { cropToFill } from "../image.js";
import { mutateNotebook } from "../notebook-mutations.js";
import { registerJobHandler } from "../queue.js";
import { mintKieOtp } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";

type AnalyzeImageSubjectsPayload = {
  type: "analyze_image_subjects";
  sourceArtifactId: string;
  sourceObjectHash: string;
  bookId: string;
  jobId: string;
  resumeTaskId?: string;
};

export const SEEDREAM_PRO_I2I_MAX_IMAGE_URLS = 10;

export type ImageSubjectReplacementRegion = {
  box?: ImageSubjectNormalizedBox;
  subjectId?: string;
  replacementArtifactId: string;
  note?: string;
};

type ReplacementRefInput = { assetId: string; filename: string };

export type GenerateImageSubjectEditPayload = {
  type: "generate_image_subject_edit";
  imageAssetId: string;
  sourceArtifactId: string;
  sourceObjectHash: string;
  subjectIds: string[];
  operation: "remove" | "edit" | "replace" | "whole_image";
  prompt?: string;
  regions?: ImageSubjectReplacementRegion[];
  editRegions?: ImageSubjectNormalizedBox[];
  replacementRefs?: ReplacementRefInput[];
  orderedImageRefs?: Array<{ role: "base" | "replacement"; artifactId: string }>;
  modelId?: string;
  bookId: string;
  notebookId: string;
  producerCellId: string;
  outputCellId: string;
  generationId?: string;
  managedByNotebook?: boolean;
  jobId: string;
};

type KieLayerResult = {
  baseUrl: string;
  layers: SeedreamLayerInput[];
};

type StoredImageSubjectEditTask = {
  adapterId: string;
  request: ImageEditProviderRequest | GrokImagineImage2ImageEditRequest;
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

// The paygate prices layer decomposition per explicit size tier (1K/1.5K/2K);
// the upstream default "auto" selects no rate and mintKieOtp rejects it as
// unbounded, so we always pick the tier nearest the source's longest side.
export function seedreamLayerDecompositionSize(
  width: number,
  height: number,
): "1K" | "1.5K" | "2K" {
  const longestSide = Math.max(width, height);
  if (longestSide <= 1280) return "1K";
  if (longestSide <= 1792) return "1.5K";
  return "2K";
}

// Seedream rejects busy scenes with a 400 "the image content is too complex
// to decompose into layers" when elements are detected automatically (no
// prompt). An element-selection prompt sidesteps that rejection, so we retry
// once with this constrained selection before failing the analysis.
export const SEEDREAM_TOO_COMPLEX_PATTERN = /too complex to decompose/i;

export const SEEDREAM_LAYER_FALLBACK_PROMPT =
  "Extract only the most prominent subjects as separate layers: each distinct "
  + "person in the foreground or midground, plus at most three large, clearly "
  + "separable foreground objects. Merge all remaining detail into the base layer.";

const SEEDREAM_TOO_COMPLEX_GUIDANCE =
  "Seedream could not decompose this image into layers, even with a "
  + "constrained subject selection. Use Draw region to target the area you "
  + "want to edit instead.";

export function seedreamLayerDecompositionRequest(
  imageUrl: string,
  width: number,
  height: number,
  prompt?: string,
): SeedreamProLayerDecompositionRequest {
  return SeedreamProLayerDecompositionRequestSchema.parse({
    model: "seedream/5-pro-layer-decomposition",
    input: {
      image_url: imageUrl,
      ...(prompt ? { prompt } : {}),
      size: seedreamLayerDecompositionSize(width, height),
      output_format: "jpeg",
    },
  });
}

function boxPositionWording(box: ImageSubjectNormalizedBox): string {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const horizontal = cx < 1 / 3 ? "left" : cx > 2 / 3 ? "right" : "center";
  const vertical = cy < 1 / 3 ? "upper" : cy > 2 / 3 ? "lower" : "middle";
  if (horizontal === "center" && vertical === "middle") return "center";
  if (horizontal === "center") return vertical;
  if (vertical === "middle") return horizontal;
  return `${vertical}-${horizontal}`;
}

function describeReplacementRegion(
  region: ImageSubjectReplacementRegion,
  map: ImageSubjectMapReadyV1 | null,
): string {
  const subject = region.subjectId && map
    ? map.subjects.find((entry) => entry.id === region.subjectId)
    : undefined;
  const box = region.box ?? subject?.normalizedBox;
  const label = subject?.label
    ?? (box ? `the ${boxPositionWording(box)} region` : "the selected region");
  const boxText = box
    ? `normalized box ${box.x.toFixed(4)},${box.y.toFixed(4)},${box.width.toFixed(4)},${box.height.toFixed(4)}`
    : "unknown box";
  const note = region.note?.trim() ? ` (${region.note.trim()})` : "";
  return `${label} at ${boxText}${note}`;
}

export function regionReplacementPrompt(
  map: ImageSubjectMapReadyV1 | null,
  regions: readonly ImageSubjectReplacementRegion[],
  orderedImageRefs: readonly { role: "base" | "replacement"; artifactId: string }[],
  prompt: string,
): string {
  const replacementIndexByArtifact = new Map<string, number>();
  let nextIndex = 2;
  for (const ref of orderedImageRefs) {
    if (ref.role !== "replacement") continue;
    if (!replacementIndexByArtifact.has(ref.artifactId)) {
      replacementIndexByArtifact.set(ref.artifactId, nextIndex);
      nextIndex += 1;
    }
  }
  const lines = regions.map((region, index) => {
    const imageIndex = replacementIndexByArtifact.get(region.replacementArtifactId)
      ?? index + 2;
    return `${index + 1}. ${describeReplacementRegion(region, map)}: replace with reference image ${imageIndex}.`;
  });
  const user = prompt.trim();
  const composed = [
    "The first image is the base scene. Following images are identity references for the listed regions.",
    "Replace only those regions and preserve every unreplaced person, object, background element, composition, and camera framing.",
    ...lines,
  ].join(" ");
  return user ? `${user}\n${composed}` : composed;
}

export function seedreamProImageUrlCapacityError(replacementCount: number): string {
  const maxReplacements = SEEDREAM_PRO_I2I_MAX_IMAGE_URLS - 1;
  return `Seedream 5 Pro image-to-image accepts at most ${SEEDREAM_PRO_I2I_MAX_IMAGE_URLS} image_urls (1 base + ${maxReplacements} replacements). This request needs 1 base + ${replacementCount} replacements.`;
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

export function imageSubjectAnalysisDeadline(
  startedAt: string,
  fallbackNow = Date.now(),
): number {
  const parsed = Date.parse(startedAt);
  return (Number.isFinite(parsed) ? parsed : fallbackNow) + KIE_RESULT_TIMEOUT_MS;
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
  if (payload.managedByNotebook) return;
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
  if (payload.managedByNotebook) return;
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
  map: ImageSubjectMapReadyV1 | null,
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
      ...(map ? { subject_analysis_id: map.analysisId } : {}),
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
  let request: ImageEditProviderRequest | GrokImagineImage2ImageEditRequest | null = null;
  let adapterId: string | null = null;
  if (storedRequest.ok) {
    for (const adapter of IMAGE_EDIT_ADAPTERS) {
      const parsed = adapter.parseStoredPayload(storedRequest.value);
      if (parsed) {
        request = parsed;
        adapterId = adapter.id;
        break;
      }
    }
    if (!request) {
      const parsedExact = GrokImagineImage2ImageEditRequestSchema.safeParse(storedRequest.value);
      if (parsedExact.success) {
        request = parsedExact.data;
        adapterId = GROK_EXACT_MASK_ADAPTER_ID;
      }
    }
  }
  const storedTask = await engine.metadata.artifacts.read<unknown>(
    imageAssetId,
    "kie-task-id",
  );
  const taskRecord = storedTask.ok ? record(storedTask.value) : null;
  const taskId = stringValue(taskRecord?.taskId);
  if (taskId && !request) {
    throw new Error("Stored Kie subject edit task has no valid generation payload");
  }
  return taskId && request && adapterId
    ? { adapterId, request, taskId }
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
    throw new Error("Exact Grok mask edit requires nonnegative mask indexes");
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

type ImageSubjectEditRoute = "semantic" | "region";

type ImageSubjectEditGeneration = {
  output: Buffer;
  extras: Buffer[];
  taskId: string;
  request: ImageEditProviderRequest;
};

function imageSubjectEditAdapter(modelId: string | undefined): ImageEditAdapter {
  const adapter = imageEditAdapter(modelId ?? DEFAULT_IMAGE_EDIT_MODEL_ID);
  if (!adapter) throw new Error(`Unknown image edit model: ${modelId}`);
  return adapter;
}

export async function previewImageSubjectEditRequest(
  engine: Engine,
  payload: Pick<GenerateImageSubjectEditPayload,
    "sourceArtifactId" | "sourceObjectHash" | "subjectIds" | "operation" | "prompt"
    | "regions" | "editRegions" | "replacementRefs" | "modelId">,
  imageUrls: string[],
): Promise<{ model: string; input: Record<string, unknown> }> {
  const source = await resolveImageSubjectSource(engine, payload.sourceArtifactId);
  if (source.objectHash !== payload.sourceObjectHash) {
    throw new Error("The requested image version is stale; refresh the asset before editing");
  }
  const stored = await readImageSubjectMapRecord(engine, payload.sourceArtifactId);
  const map = stored?.status === "ready" && stored.objectHash === source.objectHash ? stored : null;
  const regional = (payload.editRegions?.length ?? 0) > 0;
  if (payload.operation !== "whole_image" && payload.operation !== "replace" && !regional && !map) {
    throw new Error("Analyze image subjects before editing them");
  }
  if (payload.subjectIds.some((id) => !map?.subjects.some((subject) => subject.id === id))) {
    throw new Error("The saved subjects are unavailable; analyze the source image again");
  }
  if (!regional && payload.operation !== "whole_image" && payload.operation !== "replace"
    && payload.subjectIds.length === 0) {
    throw new Error("Select at least one subject to edit");
  }
  if ((payload.operation === "edit" || payload.operation === "whole_image") && !payload.prompt?.trim()) {
    throw new Error("A prompt is required to edit selected subjects");
  }
  if (payload.operation === "remove" && !regional) {
    return { model: "sharp/layer-composite", input: {
      source_artifact_id: payload.sourceArtifactId, subject_ids: payload.subjectIds,
    } };
  }
  if (!regional && payload.operation === "edit" && map
    && imageSubjectEditRoute(map, payload.subjectIds) === "exact") {
    const request = grokImagineImage2EditRequest(
      map.grokSourceTaskId!, payload.prompt ?? "", exactEditMaskIndexes(map.subjects, payload.subjectIds)!,
    );
    return { model: request.model, input: { ...request.input } };
  }
  const prompt = regional
    ? imageRegionEditPrompt(payload.editRegions!, payload.operation === "remove" ? "remove" : "edit", payload.prompt ?? "")
    : payload.operation === "replace"
      ? regionReplacementPrompt(map, payload.regions ?? [], [
          { role: "base", artifactId: payload.sourceArtifactId },
          ...(payload.replacementRefs ?? []).map((ref) => ({ role: "replacement" as const, artifactId: ref.assetId })),
        ], payload.prompt ?? "")
      : payload.operation === "whole_image" ? payload.prompt ?? ""
        : semanticEditPrompt(map!, payload.subjectIds, payload.prompt ?? "");
  const adapter = imageSubjectEditAdapter(payload.modelId);
  const input = { prompt, imageUrls, width: source.width, height: source.height };
  return payload.operation === "replace"
    ? adapter.buildRegionRequest(input)
    : adapter.buildSemanticRequest(input);
}

async function runAdapterImageSubjectEdit(
  engine: Engine,
  payload: GenerateImageSubjectEditPayload,
  adapter: ImageEditAdapter,
  route: ImageSubjectEditRoute,
  prepared: { prompt: string; width: number; height: number },
  sourceFilename: string,
  signal: AbortSignal,
): Promise<ImageSubjectEditGeneration> {
  const stored = await readStoredImageSubjectEditTask(engine, payload.imageAssetId);
  const storedMatch = stored?.adapterId === adapter.id ? stored : null;
  let request = storedMatch?.request as ImageEditProviderRequest | null ?? null;
  let taskId = storedMatch?.taskId ?? null;
  if (!request || !taskId) {
    const imageUrls = [
      await adapter.uploadAsset(engine, payload.sourceArtifactId, sourceFilename),
    ];
    if (route === "region") {
      for (const ref of payload.replacementRefs ?? []) {
        imageUrls.push(await adapter.uploadAsset(engine, ref.assetId, ref.filename));
      }
    }
    request = route === "semantic"
      ? adapter.buildSemanticRequest({ ...prepared, imageUrls })
      : adapter.buildRegionRequest({ ...prepared, imageUrls });
    taskId = await adapter.submit(engine, payload.imageAssetId, request);
  }
  if (payload.generationId) {
    const generation = await engine.generations.update(payload.generationId, {
      status: "awaiting_provider",
      error: null,
    });
    if (!generation.ok) throw new Error(generation.error.message);
  }
  await updateNotebookEditProgress(engine, payload, "awaiting_provider");
  const images = await adapter.awaitResult(taskId, signal);
  const [output, ...extras] = images;
  if (!output) throw new Error(`${adapter.id} image edit returned no image`);
  return { output, extras, taskId, request };
}

async function generateSemanticSubjectEdit(
  engine: Engine,
  payload: GenerateImageSubjectEditPayload,
  adapter: ImageEditAdapter,
  map: ImageSubjectMapReadyV1,
  sourceFilename: string,
  signal: AbortSignal,
): Promise<ImageSubjectEditGeneration> {
  return runAdapterImageSubjectEdit(
    engine,
    payload,
    adapter,
    "semantic",
    {
      prompt: semanticEditPrompt(map, payload.subjectIds, payload.prompt ?? ""),
      width: map.width,
      height: map.height,
    },
    sourceFilename,
    signal,
  );
}

async function generateWholeImageEdit(
  engine: Engine,
  payload: GenerateImageSubjectEditPayload,
  adapter: ImageEditAdapter,
  sourceFilename: string,
  width: number,
  height: number,
  signal: AbortSignal,
): Promise<ImageSubjectEditGeneration> {
  return runAdapterImageSubjectEdit(
    engine,
    payload,
    adapter,
    "semantic",
    {
      prompt: payload.prompt ?? "",
      width,
      height,
    },
    sourceFilename,
    signal,
  );
}

async function generateRegionReplacementEdit(
  engine: Engine,
  payload: GenerateImageSubjectEditPayload,
  adapter: ImageEditAdapter,
  map: ImageSubjectMapReadyV1 | null,
  sourceFilename: string,
  width: number,
  height: number,
  signal: AbortSignal,
): Promise<ImageSubjectEditGeneration> {
  const prompt = regionReplacementPrompt(
    map,
    payload.regions ?? [],
    payload.orderedImageRefs ?? [
      { role: "base", artifactId: payload.sourceArtifactId },
      ...(payload.replacementRefs ?? []).map((ref) => ({
        role: "replacement" as const,
        artifactId: ref.assetId,
      })),
    ],
    payload.prompt ?? "",
  );
  return runAdapterImageSubjectEdit(
    engine,
    payload,
    adapter,
    "region",
    { prompt, width, height },
    sourceFilename,
    signal,
  );
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
  const storedExact = stored?.adapterId === GROK_EXACT_MASK_ADAPTER_ID
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
    || (value.operation !== "remove" && value.operation !== "edit"
      && value.operation !== "replace" && value.operation !== "whole_image")
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
    ...(typeof value.modelId === "string" ? { modelId: value.modelId } : {}),
    ...(typeof value.generationId === "string"
      ? { generationId: value.generationId }
      : {}),
    ...(value.managedByNotebook === true ? { managedByNotebook: true } : {}),
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

async function submitLayerDecompositionTask(
  engine: Engine,
  provider: KieProvider,
  source: ImageSubjectSource,
  jobId: string,
  startedAt: string,
  deadlineAt: number,
  prompt?: string,
): Promise<string> {
  const imageUrl = await uploadAssetToKie(engine, source.artifactId, source.file.name);
  if (Date.now() >= deadlineAt) {
    throw new Error("Subject analysis did not finish within 25 minutes. Retry the analysis.");
  }
  const request = seedreamLayerDecompositionRequest(
    imageUrl,
    source.width,
    source.height,
    prompt,
  );
  const taskId = await submitMediaJob(provider, request, {
    otp: mintKieOtp(request),
  });
  const recorded = await writeCurrentImageSubjectAnalysisRecord(engine, {
    version: IMAGE_SUBJECT_MAP_VERSION,
    status: "analyzing",
    artifactId: source.artifactId,
    objectHash: source.objectHash,
    width: source.width,
    height: source.height,
    jobId,
    startedAt,
    taskId,
  });
  if (!recorded) {
    throw new Error("Subject analysis was superseded by a newer request");
  }
  return taskId;
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
        taskId = await submitLayerDecompositionTask(
          engine,
          provider,
          source,
          payload.jobId,
          startedAt,
          deadlineAt,
        );
      }
      let resultJson: string;
      try {
        resultJson = await waitForKieResult(
          provider,
          taskId,
          context.signal,
          deadlineAt,
          "subject-analysis",
        );
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (!SEEDREAM_TOO_COMPLEX_PATTERN.test(message)) throw cause;
        taskId = await submitLayerDecompositionTask(
          engine,
          provider,
          source,
          payload.jobId,
          startedAt,
          deadlineAt,
          SEEDREAM_LAYER_FALLBACK_PROMPT,
        );
        try {
          resultJson = await waitForKieResult(
            provider,
            taskId,
            context.signal,
            deadlineAt,
            "subject-analysis",
          );
        } catch (fallbackCause) {
          const fallbackMessage = fallbackCause instanceof Error
            ? fallbackCause.message
            : String(fallbackCause);
          if (SEEDREAM_TOO_COMPLEX_PATTERN.test(fallbackMessage)) {
            throw new Error(SEEDREAM_TOO_COMPLEX_GUIDANCE);
          }
          throw fallbackCause;
        }
      }
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
      const readyMap = record?.status === "ready" && record.objectHash === source.objectHash
        ? record
        : null;
      const editRegions = payload.editRegions ?? [];
      const regional = editRegions.length > 0;
      if (regional && payload.operation !== "edit" && payload.operation !== "remove") {
        throw new Error("Drawn-region edits require an edit or remove operation");
      }
      if (
        payload.operation !== "replace"
        && payload.operation !== "whole_image"
        && !regional
        && !readyMap
      ) {
        throw new Error("A current subject map is required before editing subjects");
      }
      if (payload.operation === "replace") {
        const missingSubjects = (payload.regions ?? []).filter((region) =>
          region.subjectId && !region.box && !readyMap);
        if (missingSubjects.length > 0) {
          throw new Error("Analyze image subjects before replacing by subject id");
        }
      }
      await updateNotebookEditProgress(engine, payload, "running");
      if ((payload.operation === "edit" || payload.operation === "whole_image") && !payload.prompt?.trim()) {
        throw new Error("A prompt is required to edit selected subjects");
      }
      const adapter = payload.operation === "remove" && !regional
        ? null
        : imageSubjectEditAdapter(payload.modelId);
      if (regional) {
        const generated = await runAdapterImageSubjectEdit(
          engine,
          payload,
          adapter!,
          "semantic",
          {
            prompt: imageRegionEditPrompt(editRegions, payload.operation === "remove" ? "remove" : "edit", payload.prompt ?? ""),
            width: source.width,
            height: source.height,
          },
          source.file.name,
          context.signal,
        );
        const original = await engine.files.read(payload.sourceArtifactId, source.file.name);
        if (!original.ok) throw new Error(original.error.message);
        const current = await resolveImageSubjectSource(engine, payload.sourceArtifactId);
        if (current.objectHash !== payload.sourceObjectHash) {
          throw new Error("The source image changed during region editing");
        }
        const output = await compositeImageRegionEdit(original.value, generated.output, editRegions);
        await persistProcessedImage(engine, payload, readyMap, output, {
          origin: payload.operation === "remove" ? "image_region_remove" : "image_region_edit",
          model: generated.request.model,
          kie_task_id: generated.taskId,
          targeting: "drawn-regions",
          edit_regions: editRegions,
        });
      } else if (payload.operation === "whole_image") {
        const generated = await generateWholeImageEdit(
          engine,
          payload,
          adapter!,
          source.file.name,
          source.width,
          source.height,
          context.signal,
        );
        await persistProcessedImage(engine, payload, readyMap, generated.output, {
          origin: "image_whole_edit",
          model: generated.request.model,
          kie_task_id: generated.taskId,
          targeting: "whole-image",
        });
      } else if (payload.operation === "replace") {
        const regions = payload.regions ?? [];
        if (regions.length === 0) {
          throw new Error("Replacement edits require at least one region");
        }
        const generated = await generateRegionReplacementEdit(
          engine,
          payload,
          adapter!,
          readyMap,
          source.file.name,
          source.width,
          source.height,
          context.signal,
        );
        await persistProcessedImage(engine, payload, readyMap, generated.output, {
          origin: "image_subject_replace",
          model: generated.request.model,
          kie_task_id: generated.taskId,
          targeting: "region-replacement",
          image_urls: generated.request.input.image_urls,
          replacement_artifact_ids: (payload.replacementRefs ?? [])
            .map((ref) => ref.assetId),
        });
      } else if (payload.operation === "remove") {
        const output = await composeImageSubjectRemoval(
          engine,
          payload.sourceArtifactId,
          readyMap!,
          payload.subjectIds,
        );
        await persistProcessedImage(engine, payload, readyMap, output, {
          model: "local/sharp-layer-composite",
        });
      } else if (imageSubjectEditRoute(readyMap!, payload.subjectIds) === "exact") {
        const generated = await generateExactSubjectEdit(
          engine,
          payload,
          readyMap!,
          context.signal,
        );
        await persistProcessedImage(engine, payload, readyMap, generated.output, {
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
          adapter!,
          readyMap!,
          source.file.name,
          context.signal,
        );
        await persistProcessedImage(engine, payload, readyMap, generated.output, {
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
      await enqueueSearchIndex(engine, payload.imageAssetId);
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

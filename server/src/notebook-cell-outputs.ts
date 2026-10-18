import { notebookOccupiedSlots } from "videobook-engine/notebook-grid";
import type {
  Engine,
  NotebookCell,
  NotebookDocument,
  NotebookEdge,
} from "videobook-engine";
import {
  findGenerateAudioOutputCell,
  findGenerateImageOutputCell,
  findGenerateVideoOutputCell,
} from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import { nextGenerationOutputSlot } from "./notebook-placement.js";
import { isPublishedPostCell } from "./notebook-published-post.js";

export const EXTRACT_FRAME_OUTPUT_ROLE = "extract-frame-output";
export const EXTRACT_AUDIO_OUTPUT_ROLE = "extract-audio-output";

function extractPairOutputType(
  extract: NotebookCell,
): "audio" | null {
  if (extract.type === "extract_audio") return "audio";
  return null;
}

function findLegacyExtractPair(
  document: NotebookDocument,
  extract: NotebookCell,
): { outputCell: NotebookCell; outputEdge: NotebookEdge } | null {
  const expectedType = extractPairOutputType(extract);
  if (!expectedType) return null;
  for (const edge of document.edges) {
    if (edge.source !== extract.id || edge.targetInput !== "media") continue;
    const outputCell = document.cells.find((cell) => cell.id === edge.target);
    if (outputCell?.type === expectedType) {
      return { outputCell, outputEdge: edge };
    }
  }
  return null;
}

function versionArtifactIds(
  cell: NotebookCell,
): string[] {
  const persisted = Array.isArray(cell.inputs?.outputVersionArtifactIds)
    ? cell.inputs.outputVersionArtifactIds.filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      )
    : [];
  return [...new Set([
    ...persisted,
    ...(cell.outputArtifactId ? [cell.outputArtifactId] : []),
  ])];
}

function adoptExtractFromPair(
  extract: NotebookCell,
  outputCell: NotebookCell,
): NotebookCell {
  const adoptedArtifact = outputCell.outputArtifactId ?? extract.outputArtifactId;
  const pairInputs = outputCell.inputs ?? {};
  const extractInputs = extract.inputs ?? {};
  const inputs: Record<string, unknown> = { ...extractInputs };
  for (const key of [
    "durationSeconds",
    "frameMode",
    "timestampSeconds",
    "atSeconds",
  ] as const) {
    if (inputs[key] === undefined && pairInputs[key] !== undefined) {
      inputs[key] = pairInputs[key];
    }
  }
  const outputVersionArtifactIds = [...new Set([
    ...versionArtifactIds(extract),
    ...versionArtifactIds(outputCell),
  ])];
  if (outputVersionArtifactIds.length > 0) {
    inputs.outputVersionArtifactIds = outputVersionArtifactIds;
  }
  if (adoptedArtifact) inputs.state = "completed";
  else if (inputs.state === "awaiting-output") delete inputs.state;
  return {
    ...extract,
    ...(adoptedArtifact ? { outputArtifactId: adoptedArtifact } : {}),
    inputs,
  };
}

export function normalizeLegacyExtractCells(
  document: NotebookDocument,
): NotebookDocument {
  return migrateLegacyExtractAudioCells(
    migrateLegacyExtractFrameCells(collapseLegacyExtractPairs(document)),
  );
}

export function collapseLegacyExtractPairs(
  document: NotebookDocument,
): NotebookDocument {
  const pairs = document.cells.flatMap((extract) => {
    const pair = findLegacyExtractPair(document, extract);
    return pair ? [{ extract, ...pair }] : [];
  });
  if (pairs.length === 0) return document;

  const deletedCellIds = new Set(pairs.map((pair) => pair.outputCell.id));
  const deletedEdgeIds = new Set(pairs.map((pair) => pair.outputEdge.id));
  const adoptByExtractId = new Map(
    pairs.map((pair) => [pair.extract.id, pair.outputCell] as const),
  );
  const rewireFrom = new Map(
    pairs.map((pair) => [pair.outputCell.id, pair.extract.id] as const),
  );

  const cells = document.cells
    .filter((cell) => !deletedCellIds.has(cell.id))
    .map((cell) => {
      const outputCell = adoptByExtractId.get(cell.id);
      return outputCell ? adoptExtractFromPair(cell, outputCell) : cell;
    });

  const seenEdges = new Set<string>();
  const edges: NotebookEdge[] = [];
  for (const edge of document.edges) {
    if (deletedEdgeIds.has(edge.id) || deletedCellIds.has(edge.target)) {
      continue;
    }
    const source = rewireFrom.get(edge.source) ?? edge.source;
    const next = source === edge.source ? edge : { ...edge, source };
    const key = `${next.source}:${next.target}:${next.targetInput}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push(next);
  }

  const execution = { ...(document.execution ?? {}) };
  for (const pair of pairs) {
    delete execution[pair.outputCell.id];
    if (execution[pair.extract.id]?.status === "awaiting-output") {
      delete execution[pair.extract.id];
    }
  }

  return {
    ...document,
    cells,
    edges,
    execution,
  };
}

function isLegacyExtractFrameProducer(
  document: NotebookDocument,
  cell: NotebookCell,
): boolean {
  if (cell.type !== "image") return false;
  const inputs = cell.inputs ?? {};
  if (inputs.mediaRole !== undefined) return false;
  if (cell.operation === "extract_frame") return true;
  if (inputs.frameMode !== undefined) return true;
  return document.edges.some((edge) =>
    edge.target === cell.id && edge.targetInput === "video");
}

function findLegacyExtractFrameOutput(
  document: NotebookDocument,
  producer: NotebookCell,
): { outputCell: NotebookCell; outputEdge: NotebookEdge } | null {
  for (const edge of document.edges) {
    if (edge.source !== producer.id || edge.targetInput !== "media") continue;
    const outputCell = document.cells.find((cell) => cell.id === edge.target);
    if (outputCell?.type === "image") {
      return { outputCell, outputEdge: edge };
    }
  }
  return null;
}

function migratedFrameOutputCell(
  carrier: NotebookCell,
  producer: NotebookCell,
  sourceCellId: string | null,
): NotebookCell {
  const inputs: Record<string, unknown> = { ...(carrier.inputs ?? {}) };
  const producerInputs = producer.inputs ?? {};
  for (const key of ["frameMode", "timestampSeconds", "atSeconds"] as const) {
    if (inputs[key] === undefined && producerInputs[key] !== undefined) {
      inputs[key] = producerInputs[key];
    }
  }
  const outputVersionArtifactIds = [...new Set([
    ...versionArtifactIds(producer),
    ...versionArtifactIds(carrier),
  ])];
  if (outputVersionArtifactIds.length > 0) {
    inputs.outputVersionArtifactIds = outputVersionArtifactIds;
  }
  inputs.mediaRole = EXTRACT_FRAME_OUTPUT_ROLE;
  if (sourceCellId) inputs.sourceCellId = sourceCellId;
  delete inputs.producerCellId;
  const outputArtifactId =
    carrier.outputArtifactId ?? producer.outputArtifactId;
  if (outputArtifactId) inputs.state = "completed";
  else if (inputs.state === "awaiting-output") delete inputs.state;
  return {
    ...carrier,
    operation: undefined,
    provider: undefined,
    model: undefined,
    tool: undefined,
    ...(outputArtifactId ? { outputArtifactId } : {}),
    inputs,
  };
}

export function migrateLegacyExtractAudioCells(
  document: NotebookDocument,
): NotebookDocument {
  const extracts = document.cells.filter((cell) => cell.type === "extract_audio");
  if (extracts.length === 0) return document;

  const retargetEdgeIds = new Map<string, string>();
  const replaceById = new Map<string, NotebookCell>();
  for (const extract of extracts) {
    const videoEdge = document.edges.find((edge) =>
      edge.target === extract.id && edge.targetInput === "video") ?? null;
    if (videoEdge) retargetEdgeIds.set(videoEdge.id, extract.id);
    const inputs: Record<string, unknown> = { ...(extract.inputs ?? {}) };
    inputs.mediaRole = EXTRACT_AUDIO_OUTPUT_ROLE;
    if (videoEdge) inputs.sourceCellId = videoEdge.source;
    delete inputs.producerCellId;
    if (extract.outputArtifactId) inputs.state = "completed";
    else if (inputs.state === "awaiting-output") delete inputs.state;
    replaceById.set(extract.id, {
      ...extract,
      type: "audio",
      operation: undefined,
      provider: undefined,
      model: undefined,
      tool: undefined,
      inputs,
    });
  }

  const cells = document.cells.map((cell) => replaceById.get(cell.id) ?? cell);
  const seenTargetInputs = new Set<string>();
  const edges: NotebookEdge[] = [];
  for (const edge of document.edges) {
    const retarget = retargetEdgeIds.get(edge.id);
    const target = retarget ?? edge.target;
    const targetInput = retarget === undefined ? edge.targetInput : "segment";
    const next =
      target === edge.target && targetInput === edge.targetInput
        ? edge
        : { ...edge, target, targetInput };
    const key = `${next.target}:${next.targetInput}`;
    if (seenTargetInputs.has(key)) continue;
    seenTargetInputs.add(key);
    edges.push(next);
  }

  return { ...document, cells, edges };
}

export function migrateLegacyExtractFrameCells(
  document: NotebookDocument,
): NotebookDocument {
  const producers = document.cells.filter((cell) =>
    isLegacyExtractFrameProducer(document, cell));
  if (producers.length === 0) return document;

  const deletedCellIds = new Set<string>();
  const deletedEdgeIds = new Set<string>();
  const rewireFrom = new Map<string, string>();
  const retargetEdgeIds = new Map<string, string>();
  const replaceById = new Map<string, NotebookCell>();

  for (const producer of producers) {
    const videoEdge = document.edges.find((edge) =>
      edge.target === producer.id && edge.targetInput === "video") ?? null;
    const sourceCellId = videoEdge?.source ?? null;
    const pair = findLegacyExtractFrameOutput(document, producer);
    const carrier = pair?.outputCell ?? producer;
    if (pair) {
      deletedCellIds.add(producer.id);
      deletedEdgeIds.add(pair.outputEdge.id);
      rewireFrom.set(producer.id, carrier.id);
    }
    if (videoEdge) retargetEdgeIds.set(videoEdge.id, carrier.id);
    replaceById.set(
      carrier.id,
      migratedFrameOutputCell(carrier, producer, sourceCellId),
    );
  }

  const cells = document.cells
    .filter((cell) => !deletedCellIds.has(cell.id))
    .map((cell) => replaceById.get(cell.id) ?? cell);

  const seenTargetInputs = new Set<string>();
  const edges: NotebookEdge[] = [];
  for (const edge of document.edges) {
    if (deletedEdgeIds.has(edge.id)) continue;
    const retarget = retargetEdgeIds.get(edge.id);
    if (retarget === undefined && deletedCellIds.has(edge.target)) continue;
    const source = deletedCellIds.has(edge.source)
      ? rewireFrom.get(edge.source) ?? edge.source
      : edge.source;
    const target = retarget ?? edge.target;
    const targetInput = retarget === undefined ? edge.targetInput : "segment";
    const next =
      source === edge.source
        && target === edge.target
        && targetInput === edge.targetInput
        ? edge
        : { ...edge, source, target, targetInput };
    const key = `${next.target}:${next.targetInput}`;
    if (seenTargetInputs.has(key)) continue;
    seenTargetInputs.add(key);
    edges.push(next);
  }

  const execution = { ...(document.execution ?? {}) };
  for (const cellId of deletedCellIds) {
    delete execution[cellId];
  }
  for (const carrierId of replaceById.keys()) {
    if (execution[carrierId]?.status === "awaiting-output") {
      delete execution[carrierId];
    }
  }

  return {
    ...document,
    cells,
    edges,
    execution,
  };
}

const GENERATE_IMAGE_OUTPUT_ROLE = "generate-image-output";
const GENERATE_VIDEO_OUTPUT_ROLE = "generate-video-output";
const GENERATE_AUDIO_OUTPUT_ROLE = "generate-audio-output";

type GenerationProducerType = "generate_video" | "generate_image" | "generate_audio";
type GenerationOutputType = "video" | "image" | "audio";

type GenerationResultMatch = {
  outputCell: NotebookCell;
  outputEdge: NotebookEdge;
};

type GenerationOutputSpec = {
  producerType: GenerationProducerType;
  outputType: GenerationOutputType;
  mediaRole: string;
  labelSuffix: string;
  concurrent: boolean;
};

const IMAGE_OUTPUT_SPEC: GenerationOutputSpec = {
  producerType: "generate_image",
  outputType: "image",
  mediaRole: GENERATE_IMAGE_OUTPUT_ROLE,
  labelSuffix: "image",
  concurrent: true,
};

const VIDEO_OUTPUT_SPEC: GenerationOutputSpec = {
  producerType: "generate_video",
  outputType: "video",
  mediaRole: GENERATE_VIDEO_OUTPUT_ROLE,
  labelSuffix: "video",
  concurrent: true,
};

const AUDIO_OUTPUT_SPEC: GenerationOutputSpec = {
  producerType: "generate_audio",
  outputType: "audio",
  mediaRole: GENERATE_AUDIO_OUTPUT_ROLE,
  labelSuffix: "audio",
  concurrent: false,
};

export function isConcurrentGenerationProducer(
  cell: Pick<NotebookCell, "type">,
): boolean {
  return cell.type === "generate_image" || cell.type === "generate_video";
}

export function isImageVideoGenerationResult(
  cell: Pick<NotebookCell, "type" | "inputs">,
): boolean {
  const role = cell.inputs?.mediaRole;
  return (cell.type === "image" && role === GENERATE_IMAGE_OUTPUT_ROLE)
    || (cell.type === "video" && role === GENERATE_VIDEO_OUTPUT_ROLE);
}

function generationAcceptedAt(cell: NotebookCell): string {
  return typeof cell.inputs?.acceptedAt === "string" ? cell.inputs.acceptedAt : "";
}

function compareGenerationResults(
  left: GenerationResultMatch,
  right: GenerationResultMatch,
): number {
  const byAccepted = generationAcceptedAt(left.outputCell)
    .localeCompare(generationAcceptedAt(right.outputCell));
  if (byAccepted !== 0) return byAccepted;
  return left.outputCell.id.localeCompare(right.outputCell.id);
}

function listGenerationOutputs(
  document: NotebookDocument,
  producerCellId: string,
  spec: GenerationOutputSpec,
): GenerationResultMatch[] {
  const matches: GenerationResultMatch[] = [];
  for (const edge of document.edges) {
    if (edge.source !== producerCellId || edge.targetInput !== "media") continue;
    const outputCell = document.cells.find((cell) => cell.id === edge.target);
    if (outputCell?.type !== spec.outputType) continue;
    if (isPublishedPostCell(outputCell)) continue;
    const role = outputCell.inputs?.mediaRole;
    const producer = outputCell.inputs?.producerCellId;
    if (
      role === spec.mediaRole
      || producer === producerCellId
      || (role === undefined && producer === undefined)
    ) {
      matches.push({ outputCell, outputEdge: edge });
    }
  }
  return matches.sort(compareGenerationResults);
}

export function listGenerateImageOutputs(
  document: NotebookDocument,
  generateImageCellId: string,
): GenerationResultMatch[] {
  return listGenerationOutputs(document, generateImageCellId, IMAGE_OUTPUT_SPEC);
}

export function listGenerateVideoOutputs(
  document: NotebookDocument,
  generateVideoCellId: string,
): GenerationResultMatch[] {
  return listGenerationOutputs(document, generateVideoCellId, VIDEO_OUTPUT_SPEC);
}

function latestCompletedResult(
  matches: GenerationResultMatch[],
): GenerationResultMatch | null {
  if (matches.length === 0) return null;
  const completed = [...matches].reverse().find((match) =>
    typeof match.outputCell.outputArtifactId === "string"
    && match.outputCell.outputArtifactId.length > 0);
  return completed ?? matches[matches.length - 1] ?? null;
}

function generationOutputInputs(
  cell: NotebookCell,
  producerCellId: string,
  mediaRole: string,
  identity?: {
    runId?: string;
    planId?: string;
    acceptedAt?: string;
  },
): Record<string, unknown> {
  return {
    ...(cell.inputs ?? {}),
    mediaRole,
    producerCellId,
    ...(identity?.runId ? { generationRunId: identity.runId } : {}),
    ...(identity?.planId ? { generationPlanId: identity.planId } : {}),
    ...(identity?.acceptedAt ? { acceptedAt: identity.acceptedAt } : {}),
  };
}

function generationOutputLabel(
  producer: NotebookCell,
  labelSuffix: string,
): string {
  const base = producer.label ?? notebookGridTag(producer.slot);
  return `${base} ${labelSuffix}`;
}

function stampGenerationOutputCell(
  producer: NotebookCell,
  outputCell: NotebookCell,
  spec: GenerationOutputSpec,
  identity?: {
    runId?: string;
    planId?: string;
    acceptedAt?: string;
  },
): NotebookCell {
  const inheritedOutput = {
    ...outputCell,
    ...(outputCell.prompt === undefined && producer.prompt !== undefined
      ? { prompt: producer.prompt }
      : {}),
    ...(outputCell.provider === undefined && producer.provider !== undefined
      ? { provider: producer.provider }
      : {}),
    ...(outputCell.model === undefined && producer.model !== undefined
      ? { model: producer.model }
      : {}),
    ...(outputCell.tool === undefined && producer.tool !== undefined
      ? { tool: producer.tool }
      : {}),
  };
  const inputs = generationOutputInputs(
    inheritedOutput,
    producer.id,
    spec.mediaRole,
    identity,
  );
  if (spec.concurrent) {
    delete inputs.outputVersionArtifactIds;
  }
  return { ...inheritedOutput, inputs };
}

type AllocatedGenerationResult = {
  document: NotebookDocument;
  outputCell: NotebookCell;
  outputEdge: NotebookEdge;
  created: boolean;
  updated: boolean;
};

function requireProducer(
  document: NotebookDocument,
  cellId: string,
  spec: GenerationOutputSpec,
): NotebookCell {
  const producer = document.cells.find((cell) => cell.id === cellId);
  if (producer?.type !== spec.producerType) {
    const label = spec.producerType === "generate_image"
      ? "Generate Image"
      : spec.producerType === "generate_audio"
        ? "Generate Audio"
        : "Generate Video";
    throw new Error(`${label} cell not found: ${cellId}`);
  }
  return producer;
}

function allocateGenerationResult(
  engine: Engine,
  document: NotebookDocument,
  producerCellId: string,
  spec: GenerationOutputSpec,
  identity: {
    runId: string;
    planId?: string;
    acceptedAt: string;
    artifactId?: string;
    state?: string;
  },
): AllocatedGenerationResult {
  const producer = requireProducer(document, producerCellId, spec);
  const occupied = notebookOccupiedSlots(document.cells);
  const created = engine.notebooks.createCell({
    type: spec.outputType,
    label: generationOutputLabel(producer, spec.labelSuffix),
    slot: nextGenerationOutputSlot(
      spec.producerType,
      producer.slot,
      occupied,
    ),
    inputs: {
      state: identity.state ?? "pending",
    },
    ...(identity.artifactId ? { outputArtifactId: identity.artifactId } : {}),
  });
  const outputCell = stampGenerationOutputCell(producer, created, spec, identity);
  const outputEdge = engine.notebooks.createEdge({
    source: producer.id,
    target: outputCell.id,
    targetInput: "media",
  });
  return {
    document: {
      ...document,
      cells: [
        ...document.cells.map((cell) =>
          cell.id === producer.id && producer.outputArtifactId
            ? { ...cell, outputArtifactId: undefined }
            : cell),
        outputCell,
      ],
      edges: [...document.edges, outputEdge],
    },
    outputCell,
    outputEdge,
    created: true,
    updated: false,
  };
}

export function allocateGenerateImageResult(
  engine: Engine,
  document: NotebookDocument,
  generateImageCellId: string,
  identity: {
    runId: string;
    planId?: string;
    acceptedAt: string;
    artifactId?: string;
    state?: string;
  },
): AllocatedGenerationResult {
  return allocateGenerationResult(
    engine,
    document,
    generateImageCellId,
    IMAGE_OUTPUT_SPEC,
    identity,
  );
}

export function allocateGenerateVideoResult(
  engine: Engine,
  document: NotebookDocument,
  generateVideoCellId: string,
  identity: {
    runId: string;
    planId?: string;
    acceptedAt: string;
    artifactId?: string;
    state?: string;
  },
): AllocatedGenerationResult {
  return allocateGenerationResult(
    engine,
    document,
    generateVideoCellId,
    VIDEO_OUTPUT_SPEC,
    identity,
  );
}

export function allocateGenerateAudioResult(
  engine: Engine,
  document: NotebookDocument,
  generateAudioCellId: string,
  identity: Parameters<typeof allocateGenerationResult>[4],
): AllocatedGenerationResult {
  return allocateGenerationResult(engine, document, generateAudioCellId, AUDIO_OUTPUT_SPEC, identity);
}

function existingResultForArtifact(
  matches: GenerationResultMatch[],
  artifactId: string,
): GenerationResultMatch | undefined {
  return matches.find((match) => match.outputCell.outputArtifactId === artifactId);
}

function stripVersionStack(cell: NotebookCell): NotebookCell {
  if (!("outputVersionArtifactIds" in (cell.inputs ?? {}))) return cell;
  const inputs = { ...(cell.inputs ?? {}) };
  delete inputs.outputVersionArtifactIds;
  return { ...cell, inputs };
}

function expandStackedProducer(
  engine: Engine,
  document: NotebookDocument,
  producer: NotebookCell,
  spec: GenerationOutputSpec,
): NotebookDocument {
  let working = document;
  let results = listGenerationOutputs(working, producer.id, spec);
  if (results.length === 0 && producer.outputArtifactId) {
    const allocated = allocateGenerationResult(engine, working, producer.id, spec, {
      runId: `legacy-inline-${producer.id}`,
      acceptedAt: producer.id,
      artifactId: producer.outputArtifactId,
      state: "completed",
    });
    working = {
      ...allocated.document,
      cells: allocated.document.cells.map((cell) =>
        cell.id === producer.id ? { ...cell, outputArtifactId: undefined } : cell),
    };
    results = listGenerationOutputs(working, producer.id, spec);
  }
  const leftoverInline = working.cells.find((cell) => cell.id === producer.id)
    ?.outputArtifactId;
  if (leftoverInline && !existingResultForArtifact(results, leftoverInline)) {
    const allocated = allocateGenerationResult(engine, working, producer.id, spec, {
      runId: `legacy-inline-${leftoverInline}`,
      acceptedAt: "0",
      artifactId: leftoverInline,
      state: "completed",
    });
    working = allocated.document;
    results = listGenerationOutputs(working, producer.id, spec);
  } else if (leftoverInline) {
    working = {
      ...working,
      cells: working.cells.map((cell) =>
        cell.id === producer.id ? { ...cell, outputArtifactId: undefined } : cell),
    };
  }
  for (const result of results) {
    const versions = versionArtifactIds(result.outputCell);
    const current = result.outputCell.outputArtifactId ?? versions.at(-1);
    const historical = versions.filter((artifactId) => artifactId !== current);
    if (historical.length === 0) {
      if (result.outputCell.inputs?.outputVersionArtifactIds) {
        working = {
          ...working,
          cells: working.cells.map((cell) =>
            cell.id === result.outputCell.id ? stripVersionStack(cell) : cell),
        };
      }
      continue;
    }
    working = {
      ...working,
      cells: working.cells.map((cell) => {
        if (cell.id !== result.outputCell.id) return cell;
        const inputs = { ...(cell.inputs ?? {}) };
        delete inputs.outputVersionArtifactIds;
        if (current) inputs.state = "completed";
        return {
          ...cell,
          ...(current ? { outputArtifactId: current } : {}),
          inputs,
        };
      }),
    };
    const live = listGenerationOutputs(working, producer.id, spec);
    for (const artifactId of historical) {
      if (existingResultForArtifact(live, artifactId)) continue;
      const allocated = allocateGenerationResult(
        engine,
        working,
        producer.id,
        spec,
        {
          runId: `legacy-stack-${artifactId}`,
          acceptedAt: "0",
          artifactId,
          state: "completed",
        },
      );
      working = allocated.document;
      live.push({
        outputCell: allocated.outputCell,
        outputEdge: allocated.outputEdge,
      });
    }
  }
  return working;
}

export function migrateStackedGenerationResults(
  engine: Engine,
  document: NotebookDocument,
): NotebookDocument {
  let working = document;
  for (const cell of document.cells) {
    if (cell.type === "generate_image") {
      working = expandStackedProducer(engine, working, cell, IMAGE_OUTPUT_SPEC);
    } else if (cell.type === "generate_video") {
      working = expandStackedProducer(engine, working, cell, VIDEO_OUTPUT_SPEC);
    }
  }
  return working;
}

function lookupLatestResult(
  document: NotebookDocument,
  producerCellId: string,
  spec: GenerationOutputSpec,
  fallback: (
    document: NotebookDocument,
    producerCellId: string,
  ) => GenerationResultMatch | null,
): GenerationResultMatch | null {
  const listed = listGenerationOutputs(document, producerCellId, spec);
  return latestCompletedResult(listed) ?? fallback(document, producerCellId);
}

export function findGenerateVideoOutput(
  document: NotebookDocument,
  generateVideoCellId: string,
) {
  return lookupLatestResult(
    document,
    generateVideoCellId,
    VIDEO_OUTPUT_SPEC,
    findGenerateVideoOutputCell,
  );
}

export function findGenerateImageOutput(
  document: NotebookDocument,
  generateImageCellId: string,
) {
  return lookupLatestResult(
    document,
    generateImageCellId,
    IMAGE_OUTPUT_SPEC,
    findGenerateImageOutputCell,
  );
}

export function findGenerateAudioOutput(
  document: NotebookDocument,
  generateAudioCellId: string,
) {
  return findGenerateAudioOutputCell(document, generateAudioCellId);
}

export function findGenerationResultForRun(
  document: NotebookDocument,
  producer: NotebookCell,
  identity: {
    runId?: string;
    outputCellId?: string;
  },
): GenerationResultMatch | null {
  if (identity.outputCellId) {
    const outputCell = document.cells.find((cell) =>
      cell.id === identity.outputCellId);
    const outputEdge = document.edges.find((edge) =>
      edge.source === producer.id
      && edge.target === identity.outputCellId
      && edge.targetInput === "media");
    if (!outputCell || !outputEdge) return null;
    const boundRunId = outputCell.inputs?.generationRunId
      ?? document.execution?.[outputCell.id]?.runId;
    if (
      identity.runId
      && typeof boundRunId === "string"
      && boundRunId !== identity.runId
    ) {
      return null;
    }
    return { outputCell, outputEdge };
  }
  if (identity.runId) {
    const spec = producer.type === "generate_image"
      ? IMAGE_OUTPUT_SPEC
      : producer.type === "generate_video"
        ? VIDEO_OUTPUT_SPEC
        : AUDIO_OUTPUT_SPEC;
    const match = listGenerationOutputs(document, producer.id, spec).find((item) =>
      item.outputCell.inputs?.generationRunId === identity.runId
      || document.execution?.[item.outputCell.id]?.runId === identity.runId);
    if (match) return match;
    if (spec.concurrent) return null;
  }
  return findGenerationMediaOutput(document, producer);
}

function ensureAudioOutput(
  engine: Engine,
  document: NotebookDocument,
  generateAudioCellId: string,
) {
  const producer = requireProducer(document, generateAudioCellId, AUDIO_OUTPUT_SPEC);
  const existing = findGenerateAudioOutput(document, generateAudioCellId);
  if (existing) {
    const outputCell = stampGenerationOutputCell(
      producer,
      existing.outputCell,
      AUDIO_OUTPUT_SPEC,
    );
    const inlineArtifactId = producer.outputArtifactId;
    const withInline = inlineArtifactId && !outputCell.outputArtifactId
      ? {
          ...outputCell,
          outputArtifactId: inlineArtifactId,
          inputs: { ...outputCell.inputs, state: "completed" },
        }
      : outputCell;
    const unchanged = existing.outputCell.inputs?.mediaRole === AUDIO_OUTPUT_SPEC.mediaRole
      && existing.outputCell.inputs?.producerCellId === generateAudioCellId
      && existing.outputCell.prompt === withInline.prompt
      && existing.outputCell.provider === withInline.provider
      && existing.outputCell.model === withInline.model
      && existing.outputCell.tool === withInline.tool
      && !producer.outputArtifactId;
    if (unchanged) {
      return { document, ...existing, created: false, updated: false };
    }
    return {
      document: {
        ...document,
        cells: document.cells.map((cell) => {
          if (cell.id === withInline.id) return withInline;
          if (cell.id === producer.id && producer.outputArtifactId) {
            return { ...cell, outputArtifactId: undefined };
          }
          return cell;
        }),
      },
      outputCell: withInline,
      outputEdge: existing.outputEdge,
      created: false,
      updated: true,
    };
  }
  return allocateGenerationResult(
    engine,
    document,
    generateAudioCellId,
    AUDIO_OUTPUT_SPEC,
    {
      runId: `audio-${generateAudioCellId}`,
      acceptedAt: generateAudioCellId,
      ...(producer.outputArtifactId
        ? { artifactId: producer.outputArtifactId, state: "completed" }
        : {}),
    },
  );
}

export function ensureGenerateVideoOutput(
  engine: Engine,
  document: NotebookDocument,
  generateVideoCellId: string,
) {
  const producer = requireProducer(document, generateVideoCellId, VIDEO_OUTPUT_SPEC);
  const migrated = expandStackedProducer(engine, document, producer, VIDEO_OUTPUT_SPEC);
  const existing = findGenerateVideoOutput(migrated, generateVideoCellId);
  if (existing) {
    return {
      document: migrated,
      ...existing,
      created: migrated !== document,
      updated: migrated !== document,
    };
  }
  return allocateGenerateVideoResult(engine, migrated, generateVideoCellId, {
    runId: `legacy-ensure-${generateVideoCellId}`,
    acceptedAt: generateVideoCellId,
  });
}

export function ensureGenerateImageOutput(
  engine: Engine,
  document: NotebookDocument,
  generateImageCellId: string,
) {
  const producer = requireProducer(document, generateImageCellId, IMAGE_OUTPUT_SPEC);
  const migrated = expandStackedProducer(engine, document, producer, IMAGE_OUTPUT_SPEC);
  const existing = findGenerateImageOutput(migrated, generateImageCellId);
  if (existing) {
    return {
      document: migrated,
      ...existing,
      created: migrated !== document,
      updated: migrated !== document,
    };
  }
  return allocateGenerateImageResult(engine, migrated, generateImageCellId, {
    runId: `legacy-ensure-${generateImageCellId}`,
    acceptedAt: generateImageCellId,
  });
}

export function ensureGenerateAudioOutput(
  engine: Engine,
  document: NotebookDocument,
  generateAudioCellId: string,
) {
  return ensureAudioOutput(engine, document, generateAudioCellId);
}

export function findGenerationMediaOutput(
  document: NotebookDocument,
  cell: NotebookCell,
) {
  if (cell.type === "generate_video") {
    return findGenerateVideoOutput(document, cell.id);
  }
  if (cell.type === "generate_image") {
    return findGenerateImageOutput(document, cell.id);
  }
  if (cell.type === "generate_audio") {
    return findGenerateAudioOutput(document, cell.id);
  }
  return null;
}

export function ensureGenerationMediaOutput(
  engine: Engine,
  document: NotebookDocument,
  cell: NotebookCell,
) {
  if (cell.type === "generate_audio") {
    return ensureGenerateAudioOutput(engine, document, cell.id);
  }
  if (cell.type === "generate_video") {
    const existing = findGenerateVideoOutput(document, cell.id);
    if (existing) return { document, ...existing, created: false, updated: false };
    throw new Error(`Generate Video result cell is not allocated for ${cell.id}`);
  }
  if (cell.type === "generate_image") {
    const existing = findGenerateImageOutput(document, cell.id);
    if (existing) return { document, ...existing, created: false, updated: false };
    throw new Error(`Generate Image result cell is not allocated for ${cell.id}`);
  }
  throw new Error(`Generation output cell is not supported for ${cell.type}`);
}

export function ensureGenerationMediaOutputs(
  engine: Engine,
  document: NotebookDocument,
): NotebookDocument {
  let working = migrateStackedGenerationResults(engine, document);
  for (const cell of working.cells) {
    if (cell.type !== "generate_audio") continue;
    working = ensureGenerateAudioOutput(engine, working, cell.id).document;
  }
  return working;
}

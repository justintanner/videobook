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

type ExtractFrameMode = "first" | "time" | "last";

type ExtractFrameSelection = {
  frameMode: ExtractFrameMode;
  sourceCellId: string | null;
  timestampSeconds: number | null;
  key: string;
};

function normalizedFrameMode(value: unknown): ExtractFrameMode {
  return value === "time" || value === "last" ? value : "first";
}

function normalizedTimestamp(value: unknown): number | null {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp >= 0
    ? Math.round(timestamp * 1_000) / 1_000
    : null;
}

function extractFrameSelectionKey(
  sourceCellId: string | null,
  frameMode: ExtractFrameMode,
  timestampSeconds: number | null = null,
): string {
  const source = sourceCellId ?? "unconnected";
  const timestamp = frameMode === "time"
    ? String(timestampSeconds ?? "invalid")
    : "frame";
  return `${source}:${frameMode}:${timestamp}`;
}

export function extractFrameSelection(
  document: NotebookDocument,
  extractFrameCellId: string,
): ExtractFrameSelection {
  const extractFrame = document.cells.find((cell) =>
    cell.id === extractFrameCellId);
  if (extractFrame?.type !== "extract_frame") {
    throw new Error(`Extract Frame cell not found: ${extractFrameCellId}`);
  }
  const frameMode = normalizedFrameMode(extractFrame.inputs?.frameMode);
  const timestampSeconds = frameMode === "time"
    ? normalizedTimestamp(extractFrame.inputs?.timestampSeconds)
    : null;
  const sourceCellId = document.edges.find((edge) =>
    edge.target === extractFrameCellId && edge.targetInput === "video")
    ?.source ?? null;
  return {
    frameMode,
    sourceCellId,
    timestampSeconds,
    key: extractFrameSelectionKey(
      sourceCellId,
      frameMode,
      timestampSeconds,
    ),
  };
}

function extractPairOutputType(
  extract: NotebookCell,
): "audio" | "image" | null {
  if (extract.type === "extract_audio") return "audio";
  if (extract.type === "extract_frame") return "image";
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

type GenerationProducerType = "generate_video" | "generate_image" | "generate_audio";
type GenerationOutputType = "video" | "image" | "audio";

type GenerationOutputSpec = {
  producerType: GenerationProducerType;
  outputType: GenerationOutputType;
  mediaRole: string;
  labelSuffix: string;
  find: (
    document: NotebookDocument,
    cellId: string,
  ) => ReturnType<typeof findGenerateVideoOutputCell>;
};

function generationOutputInputs(
  cell: NotebookCell,
  producerCellId: string,
  mediaRole: string,
): Record<string, unknown> {
  return {
    ...(cell.inputs ?? {}),
    mediaRole,
    producerCellId,
  };
}

function generationOutputLabel(
  producer: NotebookCell,
  labelSuffix: string,
): string {
  const base = producer.label ?? notebookGridTag(producer.slot);
  return `${base} ${labelSuffix}`;
}

function ensureGenerationOutput(
  engine: Engine,
  document: NotebookDocument,
  cellId: string,
  spec: GenerationOutputSpec,
) {
  const producer = document.cells.find((cell) => cell.id === cellId);
  if (producer?.type !== spec.producerType) {
    const label = spec.producerType === "generate_image"
      ? "Generate Image"
      : spec.producerType === "generate_audio"
        ? "Generate Audio"
        : "Generate Video";
    throw new Error(`${label} cell not found: ${cellId}`);
  }
  const existing = spec.find(document, cellId);
  if (existing) {
    const inputs = generationOutputInputs(
      existing.outputCell,
      cellId,
      spec.mediaRole,
    );
    const unchanged = existing.outputCell.inputs?.mediaRole === spec.mediaRole
      && existing.outputCell.inputs?.producerCellId === cellId;
    if (unchanged) {
      return { document, ...existing, created: false, updated: false };
    }
    const outputCell = { ...existing.outputCell, inputs };
    return {
      document: {
        ...document,
        cells: document.cells.map((cell) =>
          cell.id === outputCell.id ? outputCell : cell),
      },
      outputCell,
      outputEdge: existing.outputEdge,
      created: false,
      updated: true,
    };
  }
  const occupied = document.cells.map((cell) => cell.slot);
  const outputCell = engine.notebooks.createCell({
    type: spec.outputType,
    label: generationOutputLabel(producer, spec.labelSuffix),
    slot: nextGenerationOutputSlot(spec.producerType, producer.slot, occupied),
    inputs: generationOutputInputs(
      { ...producer, inputs: { state: "pending" } },
      producer.id,
      spec.mediaRole,
    ),
  });
  const outputEdge = engine.notebooks.createEdge({
    source: producer.id,
    target: outputCell.id,
    targetInput: "media",
  });
  return {
    document: {
      ...document,
      cells: [...document.cells, outputCell],
      edges: [...document.edges, outputEdge],
    },
    outputCell,
    outputEdge,
    created: true,
    updated: false,
  };
}

export function findGenerateVideoOutput(
  document: NotebookDocument,
  generateVideoCellId: string,
) {
  return findGenerateVideoOutputCell(document, generateVideoCellId);
}

export function findGenerateImageOutput(
  document: NotebookDocument,
  generateImageCellId: string,
) {
  return findGenerateImageOutputCell(document, generateImageCellId);
}

export function findGenerateAudioOutput(
  document: NotebookDocument,
  generateAudioCellId: string,
) {
  return findGenerateAudioOutputCell(document, generateAudioCellId);
}

export function ensureGenerateVideoOutput(
  engine: Engine,
  document: NotebookDocument,
  generateVideoCellId: string,
) {
  return ensureGenerationOutput(engine, document, generateVideoCellId, {
    producerType: "generate_video",
    outputType: "video",
    mediaRole: "generate-video-output",
    labelSuffix: "video",
    find: findGenerateVideoOutput,
  });
}

export function ensureGenerateImageOutput(
  engine: Engine,
  document: NotebookDocument,
  generateImageCellId: string,
) {
  return ensureGenerationOutput(engine, document, generateImageCellId, {
    producerType: "generate_image",
    outputType: "image",
    mediaRole: "generate-image-output",
    labelSuffix: "image",
    find: findGenerateImageOutput,
  });
}

export function ensureGenerateAudioOutput(
  engine: Engine,
  document: NotebookDocument,
  generateAudioCellId: string,
) {
  return ensureGenerationOutput(engine, document, generateAudioCellId, {
    producerType: "generate_audio",
    outputType: "audio",
    mediaRole: "generate-audio-output",
    labelSuffix: "audio",
    find: findGenerateAudioOutput,
  });
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
  if (cell.type === "generate_video") {
    return ensureGenerateVideoOutput(engine, document, cell.id);
  }
  if (cell.type === "generate_image") {
    return ensureGenerateImageOutput(engine, document, cell.id);
  }
  if (cell.type === "generate_audio") {
    return ensureGenerateAudioOutput(engine, document, cell.id);
  }
  throw new Error(`Generation output cell is not supported for ${cell.type}`);
}

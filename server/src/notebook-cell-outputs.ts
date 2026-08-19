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

function generationOutputCell(
  producer: NotebookCell,
  outputCell: NotebookCell,
  producerCellId: string,
  mediaRole: string,
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
  let inputs = generationOutputInputs(
    inheritedOutput,
    producerCellId,
    mediaRole,
  );
  const inlineArtifactId = producer.outputArtifactId;
  if (!inlineArtifactId) return { ...inheritedOutput, inputs };
  if (!inheritedOutput.outputArtifactId) {
    return {
      ...inheritedOutput,
      outputArtifactId: inlineArtifactId,
      inputs: { ...inputs, state: "completed" },
    };
  }
  if (inheritedOutput.outputArtifactId !== inlineArtifactId) {
    inputs = {
      ...inputs,
      outputVersionArtifactIds: [...new Set([
        inlineArtifactId,
        ...versionArtifactIds(inheritedOutput),
      ])],
    };
  }
  return { ...inheritedOutput, inputs };
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
    const outputCell = generationOutputCell(
      producer,
      existing.outputCell,
      cellId,
      spec.mediaRole,
    );
    const unchanged = existing.outputCell.inputs?.mediaRole === spec.mediaRole
      && existing.outputCell.inputs?.producerCellId === cellId
      && existing.outputCell.prompt === outputCell.prompt
      && existing.outputCell.provider === outputCell.provider
      && existing.outputCell.model === outputCell.model
      && existing.outputCell.tool === outputCell.tool
      && !producer.outputArtifactId;
    if (unchanged) {
      return { document, ...existing, created: false, updated: false };
    }
    return {
      document: {
        ...document,
        cells: document.cells.map((cell) => {
          if (cell.id === outputCell.id) return outputCell;
          if (cell.id === producer.id && producer.outputArtifactId) {
            return { ...cell, outputArtifactId: undefined };
          }
          return cell;
        }),
      },
      outputCell,
      outputEdge: existing.outputEdge,
      created: false,
      updated: true,
    };
  }
  const occupied = document.cells.map((cell) => cell.slot);
  const outputCell = generationOutputCell(
    producer,
    engine.notebooks.createCell({
      type: spec.outputType,
      label: generationOutputLabel(producer, spec.labelSuffix),
      slot: nextGenerationOutputSlot(
        spec.producerType,
        producer.slot,
        occupied,
      ),
      inputs: { state: "pending" },
    }),
    producer.id,
    spec.mediaRole,
  );
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

export function ensureGenerationMediaOutputs(
  engine: Engine,
  document: NotebookDocument,
): NotebookDocument {
  let working = document;
  const cellIds = document.cells
    .filter((cell) =>
      cell.type === "generate_video"
      || cell.type === "generate_image"
      || cell.type === "generate_audio")
    .map((cell) => cell.id);
  for (const cellId of cellIds) {
    const cell = working.cells.find((candidate) => candidate.id === cellId);
    if (!cell) continue;
    working = ensureGenerationMediaOutput(engine, working, cell).document;
  }
  return working;
}

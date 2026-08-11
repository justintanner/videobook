import type {
  Engine,
  NotebookCell,
  NotebookDocument,
  NotebookGridSlot,
} from "videobook-engine";
import {
  findGenerateVideoOutputCell,
  NOTEBOOK_GRID_COLUMN_COUNT,
  NOTEBOOK_GRID_ROW_COUNT,
  nextHorizontalSlotFrom,
  nextVerticalSlotFrom,
} from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";

export { findGenerateVideoOutputCell, resolveGeneratedVideoArtifact } from "videobook-engine";

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

export function extractFrameSelectionKey(
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

function extractFrameOutputInputs(
  cell: NotebookCell,
  extractFrameCellId: string,
  selection: ExtractFrameSelection,
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {
    ...(cell.inputs ?? {}),
    mediaRole: "extract-frame-output",
    producerCellId: extractFrameCellId,
    frameMode: selection.frameMode,
    frameSelectionKey: selection.key,
  };
  delete inputs.sourceCellId;
  delete inputs.timestampSeconds;
  if (selection.sourceCellId) inputs.sourceCellId = selection.sourceCellId;
  if (selection.frameMode === "time" && selection.timestampSeconds !== null) {
    inputs.timestampSeconds = selection.timestampSeconds;
  }
  return inputs;
}

function frameSelectionMatches(
  cell: NotebookCell,
  selection: ExtractFrameSelection,
): boolean {
  if (cell.inputs?.frameSelectionKey === selection.key) return true;
  const frameMode = normalizedFrameMode(cell.inputs?.frameMode);
  if (frameMode !== selection.frameMode) return false;
  if (
    frameMode === "time"
    && normalizedTimestamp(cell.inputs?.timestampSeconds)
      !== selection.timestampSeconds
  ) {
    return false;
  }
  const sourceCellId = typeof cell.inputs?.sourceCellId === "string"
    ? cell.inputs.sourceCellId
    : null;
  return sourceCellId === null || sourceCellId === selection.sourceCellId;
}

function outputFrameLabel(
  extractFrame: NotebookCell,
  selection: ExtractFrameSelection,
): string {
  const base = extractFrame.label ?? notebookGridTag(extractFrame.slot);
  if (selection.frameMode === "last") return `${base} last frame`;
  if (selection.frameMode !== "time") return `${base} first frame`;
  return `${base} frame at ${selection.timestampSeconds ?? 0}s`;
}

export function findExtractFrameImageOutput(
  document: NotebookDocument,
  extractFrameCellId: string,
) {
  const selection = extractFrameSelection(document, extractFrameCellId);
  for (const edge of document.edges) {
    if (
      edge.source !== extractFrameCellId
      || edge.targetInput !== "media"
    ) {
      continue;
    }
    const outputCell = document.cells.find((cell) =>
      cell.id === edge.target);
    if (
      outputCell?.type === "image"
      && frameSelectionMatches(outputCell, selection)
    ) {
      return { outputCell, outputEdge: edge };
    }
  }
  return null;
}

function extractFrameSourceVideoSlot(
  document: NotebookDocument,
  extractFrame: NotebookCell,
): NotebookGridSlot | null {
  const sourceEdge = document.edges.find((edge) =>
    edge.target === extractFrame.id && edge.targetInput === "video");
  if (!sourceEdge) return null;
  const sourceCell = document.cells.find((cell) =>
    cell.id === sourceEdge.source);
  if (!sourceCell) return null;
  if (sourceCell.type === "generate_video") {
    const output = findGenerateVideoOutputCell(document, sourceCell.id);
    return output ? output.outputCell.slot : sourceCell.slot;
  }
  return sourceCell.slot;
}

export function ensureExtractFrameImageOutput(
  engine: Engine,
  document: NotebookDocument,
  extractFrameCellId: string,
) {
  const extractFrame = document.cells.find((cell) =>
    cell.id === extractFrameCellId);
  if (extractFrame?.type !== "extract_frame") {
    throw new Error(`Extract Frame cell not found: ${extractFrameCellId}`);
  }
  const selection = extractFrameSelection(document, extractFrameCellId);
  const existing = findExtractFrameImageOutput(
    document,
    extractFrameCellId,
  );
  if (existing) {
    const inputs = extractFrameOutputInputs(
      existing.outputCell,
      extractFrameCellId,
      selection,
    );
    const unchanged = existing.outputCell.inputs?.frameSelectionKey
        === selection.key
      && existing.outputCell.inputs?.frameMode === selection.frameMode
      && (existing.outputCell.inputs?.sourceCellId ?? null)
        === selection.sourceCellId
      && (selection.frameMode !== "time"
        || existing.outputCell.inputs?.timestampSeconds
          === selection.timestampSeconds);
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
  // The frame image continues the lane: directly below the source video cell
  // (resolving generate_video sources through their output video cell), so the
  // next generation it feeds stacks beneath it. Fallback: right of the action.
  const sourceVideoSlot = extractFrameSourceVideoSlot(document, extractFrame);
  const horizontalAnchor: NotebookGridSlot = {
    row: extractFrame.slot.row,
    column: extractFrame.slot.column + 1 < NOTEBOOK_GRID_COLUMN_COUNT
      ? extractFrame.slot.column + 1
      : extractFrame.slot.column,
  };
  const outputSlot = sourceVideoSlot
    ? nextVerticalSlotFrom(slotDirectlyBelow(sourceVideoSlot), occupied)
    : nextHorizontalSlotFrom(horizontalAnchor, occupied);
  const outputCell = engine.notebooks.createCell({
    type: "image",
    label: outputFrameLabel(extractFrame, selection),
    slot: outputSlot,
    inputs: extractFrameOutputInputs(
      { ...extractFrame, inputs: { state: "pending" } },
      extractFrame.id,
      selection,
    ),
  });
  const outputEdge = engine.notebooks.createEdge({
    source: extractFrame.id,
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

function extractAudioOutputInputs(
  cell: NotebookCell,
  extractAudioCellId: string,
): Record<string, unknown> {
  return {
    ...(cell.inputs ?? {}),
    mediaRole: "extract-audio-output",
    producerCellId: extractAudioCellId,
  };
}

export function findExtractAudioOutput(
  document: NotebookDocument,
  extractAudioCellId: string,
) {
  for (const edge of document.edges) {
    if (
      edge.source !== extractAudioCellId
      || edge.targetInput !== "media"
    ) {
      continue;
    }
    const outputCell = document.cells.find((cell) => cell.id === edge.target);
    if (outputCell?.type === "audio") {
      return { outputCell, outputEdge: edge };
    }
  }
  return null;
}

export function ensureExtractAudioOutput(
  engine: Engine,
  document: NotebookDocument,
  extractAudioCellId: string,
) {
  const extractAudio = document.cells.find((cell) =>
    cell.id === extractAudioCellId);
  if (extractAudio?.type !== "extract_audio") {
    throw new Error(`Extract Audio cell not found: ${extractAudioCellId}`);
  }
  const existing = findExtractAudioOutput(document, extractAudioCellId);
  if (existing) {
    const inputs = extractAudioOutputInputs(
      existing.outputCell,
      extractAudioCellId,
    );
    const unchanged = existing.outputCell.inputs?.mediaRole
        === "extract-audio-output"
      && existing.outputCell.inputs?.producerCellId === extractAudioCellId;
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
    type: "audio",
    label: `${extractAudio.label ?? notebookGridTag(extractAudio.slot)} output`,
    slot: nextHorizontalSlotFrom({
      row: extractAudio.slot.row,
      column: Math.min(
        extractAudio.slot.column + 1,
        NOTEBOOK_GRID_COLUMN_COUNT - 1,
      ),
    }, occupied),
    inputs: extractAudioOutputInputs(
      { ...extractAudio, inputs: { state: "pending" } },
      extractAudio.id,
    ),
  });
  const outputEdge = engine.notebooks.createEdge({
    source: extractAudio.id,
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

function generateVideoOutputInputs(
  cell: NotebookCell,
  generateVideoCellId: string,
): Record<string, unknown> {
  return {
    ...(cell.inputs ?? {}),
    mediaRole: "generate-video-output",
    producerCellId: generateVideoCellId,
  };
}

function outputVideoLabel(generateVideo: NotebookCell): string {
  const base = generateVideo.label ?? notebookGridTag(generateVideo.slot);
  return `${base} video`;
}

function slotDirectlyBelow(slot: NotebookGridSlot): NotebookGridSlot {
  if (slot.row + 1 < NOTEBOOK_GRID_ROW_COUNT) {
    return { row: slot.row + 1, column: slot.column };
  }
  return {
    row: slot.row,
    column: Math.min(slot.column + 1, NOTEBOOK_GRID_COLUMN_COUNT - 1),
  };
}

export function findGenerateVideoOutput(
  document: NotebookDocument,
  generateVideoCellId: string,
) {
  return findGenerateVideoOutputCell(document, generateVideoCellId);
}

export function ensureGenerateVideoOutput(
  engine: Engine,
  document: NotebookDocument,
  generateVideoCellId: string,
) {
  const generateVideo = document.cells.find((cell) =>
    cell.id === generateVideoCellId);
  if (generateVideo?.type !== "generate_video") {
    throw new Error(`Generate Video cell not found: ${generateVideoCellId}`);
  }
  const existing = findGenerateVideoOutput(document, generateVideoCellId);
  if (existing) {
    const inputs = generateVideoOutputInputs(
      existing.outputCell,
      generateVideoCellId,
    );
    const unchanged = existing.outputCell.inputs?.mediaRole
        === "generate-video-output"
      && existing.outputCell.inputs?.producerCellId === generateVideoCellId;
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
    type: "video",
    label: outputVideoLabel(generateVideo),
    slot: nextVerticalSlotFrom(
      slotDirectlyBelow(generateVideo.slot),
      occupied,
    ),
    inputs: generateVideoOutputInputs(
      { ...generateVideo, inputs: { state: "pending" } },
      generateVideo.id,
    ),
  });
  const outputEdge = engine.notebooks.createEdge({
    source: generateVideo.id,
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

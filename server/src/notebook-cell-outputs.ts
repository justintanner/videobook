import type {
  Engine,
  NotebookCell,
  NotebookDocument,
} from "videobook-engine";
import { firstEmptyNotebookGridSlot } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";

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
  const outputCell = engine.notebooks.createCell({
    type: "image",
    label: outputFrameLabel(extractFrame, selection),
    slot: firstEmptyNotebookGridSlot(
      document.cells.map((cell) => cell.slot),
    ),
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

import type {
  Engine,
  NotebookCell,
  NotebookDocument,
  NotebookGridSlot,
} from "videobook-engine";

function uniqueImageSlug(
  cells: readonly NotebookCell[],
  stem: string,
): string {
  const normalized = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = `img-${normalized || "frame"}`;
  const occupied = new Set(cells.map((cell) => cell.slug));
  if (!occupied.has(base)) return base;
  for (let ordinal = 2; ; ordinal += 1) {
    const candidate = `${base}-${String(ordinal).padStart(2, "0")}`;
    if (!occupied.has(candidate)) return candidate;
  }
}

function firstEmptyRowBelow(
  cells: readonly NotebookCell[],
  slot: NotebookGridSlot,
): NotebookGridSlot {
  const occupied = new Set(
    cells.map((cell) => `${cell.slot.row}:${cell.slot.column}`),
  );
  for (let row = slot.row + 1; ; row += 1) {
    if (!occupied.has(`${row}:${slot.column}`)) {
      return { row, column: slot.column };
    }
  }
}

export function findExtractFrameImageOutput(
  document: NotebookDocument,
  extractFrameCellId: string,
) {
  for (const edge of document.edges) {
    if (
      edge.source !== extractFrameCellId
      || edge.targetInput !== "media"
    ) {
      continue;
    }
    const outputCell = document.cells.find((cell) =>
      cell.id === edge.target);
    if (outputCell?.type === "image") {
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
  const existing = findExtractFrameImageOutput(
    document,
    extractFrameCellId,
  );
  if (existing) {
    return { document, ...existing, created: false };
  }
  const outputCell = engine.notebooks.createCell({
    type: "image",
    slug: uniqueImageSlug(
      document.cells,
      extractFrame.slug.replace(/^extract-frame-/, ""),
    ),
    slot: firstEmptyRowBelow(document.cells, extractFrame.slot),
    inputs: {
      mediaRole: "extract-frame-output",
      producerCellId: extractFrame.id,
      state: "pending",
    },
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
  };
}

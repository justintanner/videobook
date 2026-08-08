import type {
  Engine,
  NotebookCell,
  NotebookDocument,
  NotebookGridSlot,
} from "videobook-engine";
import {
  nearestOriginNotebookGridSlot,
  nextHorizontalSlotFrom,
  nextVerticalSlotFrom,
  nextWaveTileSlot,
  NOTEBOOK_GRID_COLUMN_COUNT,
  NOTEBOOK_GRID_ROW_COUNT,
} from "videobook-engine";
import {
  ensureGenerateVideoOutput,
  findExtractFrameImageOutput,
  findGenerateVideoOutput,
} from "./notebook-cell-outputs.js";

function bySlotThenId(left: NotebookCell, right: NotebookCell): number {
  if (left.slot.row !== right.slot.row) return left.slot.row - right.slot.row;
  if (left.slot.column !== right.slot.column) {
    return left.slot.column - right.slot.column;
  }
  return left.id.localeCompare(right.id);
}

function isGenerateVideoOutputCell(
  document: NotebookDocument,
  cell: NotebookCell,
): boolean {
  if (cell.type !== "video") return false;
  if (cell.inputs?.mediaRole === "generate-video-output") return true;
  const producerId = cell.inputs?.producerCellId;
  if (typeof producerId !== "string") return false;
  return document.cells.some((candidate) =>
    candidate.id === producerId && candidate.type === "generate_video");
}

function isExtractFrameOutputCell(cell: NotebookCell): boolean {
  return cell.type === "image"
    && cell.inputs?.mediaRole === "extract-frame-output";
}

function slotBelow(slot: NotebookGridSlot): NotebookGridSlot {
  if (slot.row + 1 < NOTEBOOK_GRID_ROW_COUNT) {
    return { row: slot.row + 1, column: slot.column };
  }
  return {
    row: slot.row,
    column: Math.min(slot.column + 1, NOTEBOOK_GRID_COLUMN_COUNT - 1),
  };
}

function slotRight(slot: NotebookGridSlot): NotebookGridSlot {
  if (slot.column + 1 < NOTEBOOK_GRID_COLUMN_COUNT) {
    return { row: slot.row, column: slot.column + 1 };
  }
  return {
    row: Math.min(slot.row + 1, NOTEBOOK_GRID_ROW_COUNT - 1),
    column: slot.column,
  };
}

function migrateGenerateVideoArtifacts(
  engine: Engine,
  document: NotebookDocument,
): NotebookDocument {
  let working = document;
  const generateVideos = working.cells
    .filter((cell) => cell.type === "generate_video")
    .sort(bySlotThenId);
  for (const tile of generateVideos) {
    const ensured = ensureGenerateVideoOutput(engine, working, tile.id);
    working = ensured.document;
    const liveTile = working.cells.find((cell) => cell.id === tile.id);
    const inlineArtifact = liveTile?.outputArtifactId;
    if (!inlineArtifact) continue;
    if (ensured.outputCell.outputArtifactId === inlineArtifact) {
      working = {
        ...working,
        cells: working.cells.map((cell) =>
          cell.id === tile.id
            ? { ...cell, outputArtifactId: undefined }
            : cell),
      };
      continue;
    }
    if (ensured.outputCell.outputArtifactId) continue;
    working = {
      ...working,
      cells: working.cells.map((cell) => {
        if (cell.id === ensured.outputCell.id) {
          return {
            ...cell,
            outputArtifactId: inlineArtifact,
            inputs: {
              ...(cell.inputs ?? {}),
              state: "completed",
            },
          };
        }
        if (cell.id === tile.id) {
          return { ...cell, outputArtifactId: undefined };
        }
        return cell;
      }),
    };
  }
  return working;
}

function assignDirectionalSlots(document: NotebookDocument): NotebookDocument {
  const newSlots = new Map<string, NotebookGridSlot>();
  const occupied: NotebookGridSlot[] = [];

  function claim(cellId: string, slot: NotebookGridSlot): void {
    newSlots.set(cellId, slot);
    occupied.push(slot);
  }

  const cells = [...document.cells].sort(bySlotThenId);

  for (const cell of cells) {
    if (cell.type !== "image" || isExtractFrameOutputCell(cell)) continue;
    claim(cell.id, nextHorizontalSlotFrom({ row: 0, column: 0 }, occupied));
  }

  for (const cell of cells) {
    if (cell.type !== "video" || isGenerateVideoOutputCell(document, cell)) {
      continue;
    }
    claim(cell.id, nextVerticalSlotFrom({ row: 0, column: 0 }, occupied));
  }

  for (const cell of cells) {
    if (cell.type !== "audio") continue;
    claim(cell.id, nearestOriginNotebookGridSlot(occupied));
  }

  // Wave/lane placement, dependency-ordered so a generation lands below its
  // sources and a frame chain continues its source video's column. Passes
  // repeat until nothing new can be placed (unplaceable cells fall through
  // to the catch-all).
  function cellSources(target: NotebookCell): NotebookCell[] | null {
    const sources: NotebookCell[] = [];
    for (const edge of document.edges) {
      if (edge.target !== target.id) continue;
      const source = document.cells.find((cell) => cell.id === edge.source);
      if (!source) continue;
      sources.push(source);
    }
    return sources.every((source) => newSlots.has(source.id))
      ? sources
      : null;
  }

  const baseImageRow = Math.max(
    -1,
    ...cells
      .filter((cell) => cell.type === "image" && newSlots.has(cell.id))
      .map((cell) => newSlots.get(cell.id)!.row),
  );

  let progressed = true;
  while (progressed) {
    progressed = false;

    for (const tile of cells) {
      if (tile.type !== "generate_video" || newSlots.has(tile.id)) continue;
      const sources = cellSources(tile);
      if (!sources) continue;
      const sourceSlots = sources.map((source) => newSlots.get(source.id)!);
      const waveRow = sourceSlots.length > 0
        ? Math.max(...sourceSlots.map((slot) => slot.row)) + 1
        : baseImageRow + 1;
      const baseRowSources = sourceSlots.length > 0
        && sourceSlots.every((slot) => slot.row === 0);
      const startColumn = sourceSlots.length === 0 || baseRowSources
        ? 0
        : sourceSlots[0].column;
      const tileSlot = nextWaveTileSlot(waveRow, startColumn, occupied);
      claim(tile.id, tileSlot);
      const output = findGenerateVideoOutput(document, tile.id);
      if (output) {
        claim(
          output.outputCell.id,
          nextVerticalSlotFrom(slotBelow(tileSlot), occupied),
        );
      }
      progressed = true;
    }

    for (const action of cells) {
      if (action.type !== "extract_frame" || newSlots.has(action.id)) continue;
      const sourceEdge = document.edges.find((edge) =>
        edge.target === action.id && edge.targetInput === "video");
      const sourceCell = sourceEdge
        ? document.cells.find((cell) => cell.id === sourceEdge.source)
        : undefined;
      let videoSlot: NotebookGridSlot | null = null;
      if (sourceCell?.type === "generate_video") {
        const output = findGenerateVideoOutput(document, sourceCell.id);
        const anchorCell = output?.outputCell ?? sourceCell;
        videoSlot = newSlots.get(anchorCell.id) ?? null;
      } else if (sourceCell) {
        videoSlot = newSlots.get(sourceCell.id) ?? null;
      }
      if (sourceCell && !videoSlot) continue;
      const anchor = videoSlot ?? { row: 0, column: 0 };
      const actionSlot = nextHorizontalSlotFrom(slotRight(anchor), occupied);
      claim(action.id, actionSlot);
      const frameOutput = findExtractFrameImageOutput(document, action.id);
      if (frameOutput) {
        claim(
          frameOutput.outputCell.id,
          nextVerticalSlotFrom(slotBelow(anchor), occupied),
        );
      }
      progressed = true;
    }
  }

  for (const cell of cells) {
    if (newSlots.has(cell.id)) continue;
    if (cell.type === "generate_image") {
      claim(cell.id, nextHorizontalSlotFrom({ row: 0, column: 0 }, occupied));
      continue;
    }
    claim(cell.id, nearestOriginNotebookGridSlot(occupied));
  }

  return {
    ...document,
    cells: document.cells.map((cell) => ({
      ...cell,
      slot: newSlots.get(cell.id) ?? cell.slot,
    })),
  };
}

export function relayoutNotebookDocument(
  engine: Engine,
  document: NotebookDocument,
): NotebookDocument {
  const migrated = migrateGenerateVideoArtifacts(engine, document);
  return assignDirectionalSlots(migrated);
}

export function notebookDocumentsEqual(
  left: NotebookDocument,
  right: NotebookDocument,
): boolean {
  const leftCells = [...left.cells]
    .map((cell) => ({
      id: cell.id,
      type: cell.type,
      slot: cell.slot,
      outputArtifactId: cell.outputArtifactId ?? null,
      inputs: cell.inputs ?? {},
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const rightCells = [...right.cells]
    .map((cell) => ({
      id: cell.id,
      type: cell.type,
      slot: cell.slot,
      outputArtifactId: cell.outputArtifactId ?? null,
      inputs: cell.inputs ?? {},
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const leftEdges = [...left.edges]
    .map((edge) => ({
      source: edge.source,
      target: edge.target,
      targetInput: edge.targetInput,
    }))
    .sort((a, b) =>
      `${a.source}:${a.target}:${a.targetInput}`
        .localeCompare(`${b.source}:${b.target}:${b.targetInput}`));
  const rightEdges = [...right.edges]
    .map((edge) => ({
      source: edge.source,
      target: edge.target,
      targetInput: edge.targetInput,
    }))
    .sort((a, b) =>
      `${a.source}:${a.target}:${a.targetInput}`
        .localeCompare(`${b.source}:${b.target}:${b.targetInput}`));
  return JSON.stringify({ cells: leftCells, edges: leftEdges })
    === JSON.stringify({ cells: rightCells, edges: rightEdges });
}

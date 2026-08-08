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

  for (const tile of cells) {
    if (tile.type !== "generate_video") continue;
    const tileSlot = nextVerticalSlotFrom({ row: 0, column: 0 }, occupied);
    claim(tile.id, tileSlot);
    const output = findGenerateVideoOutput(document, tile.id);
    if (output) {
      claim(
        output.outputCell.id,
        nextVerticalSlotFrom(slotBelow(tileSlot), occupied),
      );
    }
  }

  for (const action of cells) {
    if (action.type !== "extract_frame") continue;
    const sourceEdge = document.edges.find((edge) =>
      edge.target === action.id && edge.targetInput === "video");
    let anchor: NotebookGridSlot = { row: 0, column: 0 };
    if (sourceEdge) {
      const sourceCell = document.cells.find((cell) =>
        cell.id === sourceEdge.source);
      if (sourceCell?.type === "generate_video") {
        const output = findGenerateVideoOutput(document, sourceCell.id);
        if (output && newSlots.has(output.outputCell.id)) {
          anchor = newSlots.get(output.outputCell.id)!;
        } else if (newSlots.has(sourceCell.id)) {
          anchor = newSlots.get(sourceCell.id)!;
        }
      } else if (sourceCell && newSlots.has(sourceCell.id)) {
        anchor = newSlots.get(sourceCell.id)!;
      }
    }
    const actionSlot = nextHorizontalSlotFrom(slotRight(anchor), occupied);
    claim(action.id, actionSlot);
    const frameOutput = findExtractFrameImageOutput(document, action.id);
    if (frameOutput) {
      claim(
        frameOutput.outputCell.id,
        nextHorizontalSlotFrom(slotRight(actionSlot), occupied),
      );
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

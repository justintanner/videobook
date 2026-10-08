import type {
  Engine,
  NotebookCell,
  NotebookDocument,
  NotebookGridSlot,
} from "videobook-engine";
import {
  notebookCellOccupiedSlots,
  nearestOriginNotebookGridSlot,
  nextHorizontalSlotFrom,
  nextVerticalSlotFrom,
  nextWaveTileSlot,
  NOTEBOOK_GRID_COLUMN_COUNT,
} from "videobook-engine";
import {
  ensureGenerationMediaOutputs,
  findGenerateAudioOutput,
  findGenerateImageOutput,
  findGenerateVideoOutput,
} from "./notebook-cell-outputs.js";
import { slotBelow, slotRight } from "./notebook-placement.js";
import { arrangeGoalNotebook } from "./notebook-goal-layout.js";

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

function isGenerateImageOutputCell(
  document: NotebookDocument,
  cell: NotebookCell,
): boolean {
  if (cell.type !== "image") return false;
  if (cell.inputs?.mediaRole === "generate-image-output") return true;
  const producerId = cell.inputs?.producerCellId;
  if (typeof producerId !== "string") return false;
  return document.cells.some((candidate) =>
    candidate.id === producerId && candidate.type === "generate_image");
}

function isGenerateAudioOutputCell(
  document: NotebookDocument,
  cell: NotebookCell,
): boolean {
  if (cell.type !== "audio") return false;
  if (cell.inputs?.mediaRole === "generate-audio-output") return true;
  const producerId = cell.inputs?.producerCellId;
  if (typeof producerId !== "string") return false;
  return document.cells.some((candidate) =>
    candidate.id === producerId && candidate.type === "generate_audio");
}

function isExtractFrameOutputCell(cell: NotebookCell): boolean {
  return cell.type === "image"
    && cell.inputs?.mediaRole === "extract-frame-output";
}

function migrateGenerationArtifacts(
  engine: Engine,
  document: NotebookDocument,
): NotebookDocument {
  return ensureGenerationMediaOutputs(engine, document);
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
    if (cell.type !== "timeline") continue;
    newSlots.set(cell.id, cell.slot);
    occupied.push(...notebookCellOccupiedSlots(cell));
  }

  for (const cell of cells) {
    if (
      cell.type !== "image"
      || isExtractFrameOutputCell(cell)
      || isGenerateImageOutputCell(document, cell)
    ) {
      continue;
    }
    claim(cell.id, nextHorizontalSlotFrom({ row: 0, column: 0 }, occupied));
  }

  for (const cell of cells) {
    if (cell.type !== "video" || isGenerateVideoOutputCell(document, cell)) {
      continue;
    }
    claim(cell.id, nextVerticalSlotFrom({ row: 0, column: 0 }, occupied));
  }

  for (const cell of cells) {
    if (cell.type !== "audio" || isGenerateAudioOutputCell(document, cell)) {
      continue;
    }
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

  function claimGenerateImagePair(
    tile: NotebookCell,
    tileSlot: NotebookGridSlot,
  ): void {
    claim(tile.id, tileSlot);
    const output = findGenerateImageOutput(document, tile.id);
    if (output && !newSlots.has(output.outputCell.id)) {
      claim(
        output.outputCell.id,
        nextHorizontalSlotFrom(slotRight(tileSlot), occupied),
      );
    }
  }

  function claimGenerateAudioPair(
    tile: NotebookCell,
    tileSlot: NotebookGridSlot,
  ): void {
    claim(tile.id, tileSlot);
    const output = findGenerateAudioOutput(document, tile.id);
    if (output && !newSlots.has(output.outputCell.id)) {
      claim(
        output.outputCell.id,
        nextHorizontalSlotFrom(slotRight(tileSlot), occupied),
      );
    }
  }

  let progressed = true;
  while (progressed) {
    progressed = false;

    for (const tile of cells) {
      if (tile.type !== "generate_image" || newSlots.has(tile.id)) continue;
      const sources = cellSources(tile);
      if (!sources) continue;
      const sourceSlots = sources.map((source) => newSlots.get(source.id)!);
      const anchor = sourceSlots.length === 0
        ? tile.slot
        : {
            row: Math.min(...sourceSlots.map((slot) => slot.row)),
            column: Math.min(
              Math.max(...sourceSlots.map((slot) => slot.column)) + 1,
              NOTEBOOK_GRID_COLUMN_COUNT - 1,
            ),
          };
      claimGenerateImagePair(tile, nextHorizontalSlotFrom(anchor, occupied));
      progressed = true;
    }

    for (const tile of cells) {
      if (tile.type !== "generate_audio" || newSlots.has(tile.id)) continue;
      const sources = cellSources(tile);
      if (!sources) continue;
      const sourceSlots = sources.map((source) => newSlots.get(source.id)!);
      const anchor = sourceSlots.length === 0
        ? tile.slot
        : {
            row: Math.min(...sourceSlots.map((slot) => slot.row)),
            column: Math.min(
              Math.max(...sourceSlots.map((slot) => slot.column)) + 1,
              NOTEBOOK_GRID_COLUMN_COUNT - 1,
            ),
          };
      claimGenerateAudioPair(tile, nextHorizontalSlotFrom(anchor, occupied));
      progressed = true;
    }

    for (const tile of cells) {
      if (tile.type !== "generate_video" || newSlots.has(tile.id)) continue;
      const sources = cellSources(tile);
      if (!sources) continue;
      const sourceSlots = sources.map((source) => newSlots.get(source.id)!);
      const waveRow = sourceSlots.length > 0
        ? Math.max(...sourceSlots.map((slot) => slot.row)) + 1
        : tile.slot.row;
      const baseRowSources = sourceSlots.length > 0
        && sourceSlots.every((slot) => slot.row === 0);
      const startColumn = sourceSlots.length === 0
        ? tile.slot.column
        : baseRowSources
          ? 0
          : sourceSlots[0].column;
      const tileSlot = sourceSlots.length === 0
        ? nextVerticalSlotFrom(tile.slot, occupied)
        : nextWaveTileSlot(waveRow, startColumn, occupied);
      claim(tile.id, tileSlot);
      const output = findGenerateVideoOutput(document, tile.id);
      if (output && !newSlots.has(output.outputCell.id)) {
        claim(
          output.outputCell.id,
          nextVerticalSlotFrom(slotBelow(tileSlot), occupied),
        );
      }
      progressed = true;
    }

    for (const action of cells) {
      if (!isExtractFrameOutputCell(action) || newSlots.has(action.id)) continue;
      const sourceEdge = document.edges.find((edge) =>
        edge.target === action.id && edge.targetInput === "segment");
      const sourceCellId = sourceEdge?.source
        ?? (typeof action.inputs?.sourceCellId === "string"
          ? action.inputs.sourceCellId
          : undefined);
      const sourceCell = sourceCellId
        ? document.cells.find((cell) => cell.id === sourceCellId)
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
      progressed = true;
    }
  }

  for (const cell of cells) {
    if (newSlots.has(cell.id)) continue;
    if (cell.type === "generate_image") {
      claimGenerateImagePair(
        cell,
        nextHorizontalSlotFrom(cell.slot, occupied),
      );
      continue;
    }
    if (cell.type === "generate_audio") {
      claimGenerateAudioPair(
        cell,
        nextHorizontalSlotFrom(cell.slot, occupied),
      );
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
  const migrated = migrateGenerationArtifacts(engine, document);
  if (migrated.cells.some(cell => cell.type === "goal")) return arrangeGoalNotebook(migrated);
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

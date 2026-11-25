import type { Engine, NotebookDocument } from "videobook-engine";
import { NOTEBOOK_GRID_ROW_COUNT } from "videobook-engine/notebook-grid";
import { ensureGenerationMediaOutputs } from "./notebook-cell-outputs.js";
import { arrangeGoalNotebook } from "./notebook-goal-layout.js";
import { arrangeNotebookRounds } from "./notebook-rounds-arrange.js";

function arrangeRounds(document: NotebookDocument): NotebookDocument {
  const arranged = arrangeNotebookRounds(document);
  if (!arranged.ok) {
    throw new Error(
      `The rounds layout needs ${arranged.requiredRows} rows, but the grid supports ${NOTEBOOK_GRID_ROW_COUNT}.`,
    );
  }
  const slots = new Map(arranged.slots.map(({ id, row, column }) => [id, { row, column }]));
  return {
    ...document,
    cells: document.cells.map((cell) => ({ ...cell, slot: slots.get(cell.id) ?? cell.slot })),
  };
}

export function relayoutNotebookDocument(
  engine: Engine,
  document: NotebookDocument,
): NotebookDocument {
  const migrated = ensureGenerationMediaOutputs(engine, document);
  return migrated.cells.some((cell) => cell.type === "goal")
    ? arrangeGoalNotebook(migrated)
    : arrangeRounds(migrated);
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

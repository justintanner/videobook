import type { NotebookCell, NotebookDocument } from "videobook-engine";

export type InputParams = Record<string, Record<string, number>>;

function numericValues(raw: unknown): Record<string, number> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
}

export function cellInputParams(cell: Pick<NotebookCell, "inputs">): InputParams {
  const raw = cell.inputs?.inputParams;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).flatMap(([port, values]) => {
    const numeric = numericValues(values);
    return Object.keys(numeric).length > 0 ? [[port, numeric]] : [];
  }));
}

function withoutInputParams(inputs: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(inputs).filter(([key]) => key !== "inputParams"));
}

export function withInputParams(inputs: Record<string, unknown> | undefined, params: InputParams): Record<string, unknown> {
  const rest = withoutInputParams(inputs ?? {});
  return Object.keys(params).length > 0 ? { ...rest, inputParams: params } : rest;
}

function prunedCell(cell: NotebookCell, ports: ReadonlySet<string>): NotebookCell {
  if (cell.inputs?.inputParams === undefined) return cell;
  const kept = Object.fromEntries(Object.entries(cellInputParams(cell)).filter(([port]) => ports.has(port)));
  const inputs = withInputParams(cell.inputs, kept);
  return JSON.stringify(inputs) === JSON.stringify(cell.inputs) ? cell : { ...cell, inputs };
}

export function pruneInputParams(document: NotebookDocument): NotebookDocument {
  const cells = document.cells.map((cell) => prunedCell(cell, new Set(document.edges
    .filter((edge) => edge.target === cell.id)
    .map((edge) => edge.targetInput))));
  return cells.every((cell, index) => cell === document.cells[index]) ? document : { ...document, cells };
}

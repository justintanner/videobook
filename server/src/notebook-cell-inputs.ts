import type { NotebookCell, NotebookDocument, NotebookEdge } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import { cellInputParams, type InputParams } from "./generation-input-params.js";
import { generationInputMentions, remapGenerationInputPrompt } from "./generation-input-mentions.js";
import { generationInputTarget, type GenerationInputKind } from "./generation-input-targets.js";
import type { RefRole, ResolvedModel } from "./media/types.js";
import { notebookGenerationInputKind } from "./notebook-generation-contract.js";

export interface CellInputItem {
  sourceCellId: string;
  targetInput: string;
  params?: Readonly<Record<string, number>>;
}

export interface CellInputLayout {
  edges: NotebookEdge[];
  identity: ReadonlyMap<string, string>;
  inputParams: InputParams;
  convertedSettings: readonly string[];
}

type PortsByRole = Partial<Record<RefRole, readonly string[]>>;

const KIND_PORT = /^(?<kind>image|video|audio)(?:_\d+)?$/u;

function edgeKey(source: string, port: string): string {
  return `${source}:${port}`;
}

function portKind(targetInput: string): GenerationInputKind | null {
  if (targetInput === "replace_audio") return "audio";
  if (generationInputTarget("image", targetInput) !== "image") return "image";
  return (KIND_PORT.exec(targetInput)?.groups?.kind as GenerationInputKind | undefined) ?? null;
}

export function cellMediaEdges(document: NotebookDocument, cellId: string): NotebookEdge[] {
  const cells = new Map(document.cells.map((cell) => [cell.id, cell]));
  return document.edges.filter((edge) => {
    const source = cells.get(edge.source);
    return edge.target === cellId && source !== undefined && notebookGenerationInputKind(source) !== null;
  });
}

function cellInputItemError(document: NotebookDocument, cellId: string, item: CellInputItem, kept: ReadonlyMap<string, NotebookCell>): string | null {
  if (item.targetInput.trim() === "") return "Each input needs a target_input";
  if (item.sourceCellId === cellId) return "A cell cannot be its own input";
  const source = document.cells.find((cell) => cell.id === item.sourceCellId);
  if (!source) return `Source cell not found: ${item.sourceCellId}`;
  const kind = notebookGenerationInputKind(source);
  if (kind === null) return `${notebookGridTag(source.slot)} does not produce media`;
  const expected = portKind(item.targetInput);
  if (expected !== null && expected !== kind) return `${notebookGridTag(source.slot)} produces ${kind} but ${item.targetInput} takes ${expected}`;
  const holder = kept.get(item.targetInput);
  return holder ? `${item.targetInput} is already connected to ${notebookGridTag(holder.slot)}` : null;
}

export function cellInputItemsError(document: NotebookDocument, cellId: string, items: readonly CellInputItem[]): string | null {
  const media = new Set(cellMediaEdges(document, cellId).map((edge) => edge.id));
  const cells = new Map(document.cells.map((cell) => [cell.id, cell]));
  const kept = new Map(document.edges
    .filter((edge) => edge.target === cellId && !media.has(edge.id) && cells.has(edge.source))
    .map((edge) => [edge.targetInput, cells.get(edge.source)!]));
  const ports = new Set<string>();
  for (const item of items) {
    if (ports.has(item.targetInput)) return `Two inputs use ${item.targetInput}`;
    ports.add(item.targetInput);
    const error = cellInputItemError(document, cellId, item, kept);
    if (error) return error;
  }
  return null;
}

function matchOldEdges(oldEdges: readonly NotebookEdge[], items: readonly CellInputItem[]): Array<NotebookEdge | undefined> {
  const claimed = new Set<string>();
  const exact = items.map((item) => {
    const match = oldEdges.find((edge) => edge.source === item.sourceCellId && edge.targetInput === item.targetInput);
    if (match) claimed.add(match.id);
    return match;
  });
  return exact.map((match, index) => {
    if (match) return match;
    const moved = oldEdges.find((edge) => !claimed.has(edge.id) && edge.source === items[index]!.sourceCellId);
    if (moved) claimed.add(moved.id);
    return moved;
  });
}

function numeric(raw: unknown): number | null {
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function legacyItemParams(model: ResolvedModel | null, cell: NotebookCell, ports: PortsByRole): { params: InputParams; converted: string[] } {
  const raw = cell.inputs?.generationSettings;
  const settings = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const params: InputParams = {};
  const converted: string[] = [];
  for (const slot of model?.slots ?? []) {
    for (const spec of slot.itemParams) {
      for (const [index, option] of (spec.legacyOptions ?? []).entries()) {
        if (!option || settings[option] === undefined) continue;
        converted.push(option);
        const port = ports[slot.role]?.[index];
        const value = numeric(settings[option]);
        if (port && value !== null) params[port] = { ...params[port], [spec.name]: value };
      }
    }
  }
  return { params, converted };
}

function explicitParams(raw: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => Number.isFinite(value)));
}

function canonicalParams(params: InputParams): InputParams {
  return Object.fromEntries(Object.keys(params).sort().map((port) => [
    port,
    Object.fromEntries(Object.entries(params[port]!).sort(([left], [right]) => left.localeCompare(right))),
  ]));
}

export function planCellInputLayout(input: {
  document: NotebookDocument;
  cell: NotebookCell;
  items: readonly CellInputItem[];
  model: ResolvedModel | null;
  ports: PortsByRole;
  createEdge: (edge: Omit<NotebookEdge, "id">) => NotebookEdge;
}): CellInputLayout {
  const oldEdges = cellMediaEdges(input.document, input.cell.id);
  const matches = matchOldEdges(oldEdges, input.items);
  const legacy = legacyItemParams(input.model, input.cell, input.ports);
  const stored = cellInputParams(input.cell);
  const identity = new Map<string, string>();
  const inputParams: InputParams = {};
  const edges = input.items.map((item, index) => {
    const match = matches[index];
    if (match) identity.set(edgeKey(match.source, match.targetInput), item.targetInput);
    const carried = match ? { ...legacy.params[match.targetInput], ...stored[match.targetInput] } : {};
    const params = item.params ? explicitParams(item.params) : carried;
    if (Object.keys(params).length > 0) inputParams[item.targetInput] = params;
    return match && match.targetInput === item.targetInput
      ? match
      : input.createEdge({ source: item.sourceCellId, target: input.cell.id, targetInput: item.targetInput });
  });
  return { edges, identity, inputParams: canonicalParams(inputParams), convertedSettings: legacy.converted };
}

export function cellInputLayoutChanged(cell: NotebookCell, oldEdges: readonly NotebookEdge[], layout: CellInputLayout): boolean {
  const before = oldEdges.map((edge) => edgeKey(edge.source, edge.targetInput)).sort();
  const after = layout.edges.map((edge) => edgeKey(edge.source, edge.targetInput)).sort();
  return JSON.stringify(before) !== JSON.stringify(after)
    || JSON.stringify(canonicalParams(cellInputParams(cell))) !== JSON.stringify(layout.inputParams)
    || layout.convertedSettings.length > 0;
}

export function remapPromptForLayout(
  prompt: string,
  previous: NotebookDocument,
  next: NotebookDocument,
  cellId: string,
  identity: ReadonlyMap<string, string>,
): string {
  const before = generationInputMentions(cellId, previous.cells, previous.edges).map((mention) => ({
    ...mention,
    targetInput: identity.get(edgeKey(mention.sourceCellId, mention.targetInput)) ?? `${mention.targetInput}:removed`,
  }));
  return remapGenerationInputPrompt(prompt, before, generationInputMentions(cellId, next.cells, next.edges));
}

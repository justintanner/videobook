import type { NotebookCell, NotebookCellType, NotebookEdge, NotebookGridSlot } from "videobook-engine";
import { notebookOccupiedSlots } from "videobook-engine/notebook-grid";

export type RoundsCell = Pick<NotebookCell, "id" | "type" | "slot">
  & Partial<Pick<NotebookCell, "inputs" | "outputArtifactId" | "prompt">>;

export type RoundsEdge = Pick<NotebookEdge, "source" | "target" | "targetInput">;

export interface RoundsDocument<T extends RoundsCell = RoundsCell> {
  cells: readonly T[];
  edges: readonly RoundsEdge[];
}

export interface NotebookRound {
  key: string;
  prompt: string;
  takeIds: string[];
}

export interface GeneratorRounds {
  generatorId: string;
  rounds: NotebookRound[];
  currentRound: number;
}

export interface NotebookRoundsModel {
  cellsById: ReadonlyMap<string, RoundsCell>;
  parents: ReadonlyMap<string, readonly string[]>;
  children: ReadonlyMap<string, readonly string[]>;
  takeOwner: ReadonlyMap<string, string>;
  generators: readonly GeneratorRounds[];
  bandOf: ReadonlyMap<string, string>;
  inputsOf: ReadonlyMap<string, readonly string[]>;
  finishesOf: ReadonlyMap<string, readonly string[]>;
}

const GENERATOR_TYPES: ReadonlySet<NotebookCellType> = new Set([
  "generate_video",
  "generate_image",
  "generate_audio",
]);

const VIDEO_FAMILY: ReadonlySet<NotebookCellType> = new Set(["video", "concat", "splice", "split_video"]);
const IMAGE_FAMILY: ReadonlySet<NotebookCellType> = new Set(["image"]);
const AUDIO_FAMILY: ReadonlySet<NotebookCellType> = new Set(["audio", "extract_audio"]);

const PROMPT_TOKEN = /[^\s,.;:!?]+|[,.;:!?]/gu;
const NOT_RUN = "~";

export function compareIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function isRoundsGenerator(cell: Pick<RoundsCell, "type">): boolean {
  return GENERATOR_TYPES.has(cell.type);
}

export function notebookPromptTokens(text: string): string[] {
  return text.match(PROMPT_TOKEN) ?? [];
}

export function notebookPromptKey(text: string): string {
  return notebookPromptTokens(text).join(" ").toLowerCase();
}

function stringInput(cell: RoundsCell, key: string): string | undefined {
  const value = cell.inputs?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function postSourceCellId(cell: RoundsCell): string | undefined {
  const post = cell.inputs?.post;
  if (!post || typeof post !== "object") return undefined;
  const source = (post as Record<string, unknown>).source;
  if (!source || typeof source !== "object") return undefined;
  const cellId = (source as Record<string, unknown>).cellId;
  return typeof cellId === "string" && cellId.length > 0 ? cellId : undefined;
}

function versionArtifactIds(cell: RoundsCell): string[] {
  const versions = cell.inputs?.outputVersionArtifactIds;
  return Array.isArray(versions)
    ? versions.filter((value): value is string => typeof value === "string")
    : [];
}

function artifactOwners(cells: readonly RoundsCell[]): Map<string, string> {
  const owners = new Map<string, string>();
  for (const cell of cells) {
    for (const artifactId of [cell.outputArtifactId, ...versionArtifactIds(cell)]) {
      if (artifactId && !owners.has(artifactId)) owners.set(artifactId, cell.id);
    }
  }
  return owners;
}

function declaredParents(cell: RoundsCell, owners: ReadonlyMap<string, string>): string[] {
  const artifactId = stringInput(cell, "sourceArtifactId") ?? stringInput(cell, "source_asset_id");
  return [
    stringInput(cell, "producerCellId"),
    stringInput(cell, "sourceCellId"),
    artifactId === undefined ? undefined : owners.get(artifactId),
    cell.type === "post" ? postSourceCellId(cell) : undefined,
  ].filter((id): id is string => id !== undefined);
}

function familyRank(type: NotebookCellType): number {
  if (VIDEO_FAMILY.has(type)) return 0;
  if (IMAGE_FAMILY.has(type)) return 1;
  if (AUDIO_FAMILY.has(type)) return 2;
  return 3;
}

export function compareRoundsInputs(
  cellsById: ReadonlyMap<string, RoundsCell>,
): (left: string, right: string) => number {
  return (left, right) => {
    const leftCell = cellsById.get(left);
    const rightCell = cellsById.get(right);
    const byFamily = (leftCell ? familyRank(leftCell.type) : 4) - (rightCell ? familyRank(rightCell.type) : 4);
    return byFamily || compareIds(left, right);
  };
}

function linkable(cellsById: ReadonlyMap<string, RoundsCell>, id: string): boolean {
  const cell = cellsById.get(id);
  return cell !== undefined && cell.type !== "timeline";
}

function addLink(links: Map<string, string[]>, from: string, to: string): void {
  const list = links.get(from) ?? [];
  if (!list.includes(to)) list.push(to);
  links.set(from, list);
}

function roundsLinks(
  document: RoundsDocument,
  cellsById: ReadonlyMap<string, RoundsCell>,
): { parents: Map<string, string[]>; children: Map<string, string[]> } {
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  const link = (parent: string, child: string) => {
    if (parent === child || !linkable(cellsById, parent) || !linkable(cellsById, child)) return;
    addLink(parents, child, parent);
    addLink(children, parent, child);
  };
  for (const edge of document.edges) link(edge.source, edge.target);
  const owners = artifactOwners(document.cells);
  for (const cell of document.cells) {
    for (const parent of declaredParents(cell, owners)) link(parent, cell.id);
  }
  return { parents, children };
}

function takeOwners(
  document: RoundsDocument,
  cellsById: ReadonlyMap<string, RoundsCell>,
): Map<string, string> {
  const owners = new Map<string, string>();
  const ownTake = (generatorId: string | undefined, takeId: string) => {
    const generator = generatorId === undefined ? undefined : cellsById.get(generatorId);
    const take = cellsById.get(takeId);
    if (!generator || !take || !isRoundsGenerator(generator) || isRoundsGenerator(take)) return;
    if (take.type === "timeline" || owners.has(takeId)) return;
    owners.set(takeId, generator.id);
  };
  for (const cell of document.cells) ownTake(stringInput(cell, "producerCellId"), cell.id);
  for (const edge of document.edges) {
    if (edge.targetInput === "media") ownTake(edge.source, edge.target);
  }
  return owners;
}

function takePrompt(cell: RoundsCell): string {
  return cell.prompt ?? stringInput(cell, "resolvedPrompt") ?? "";
}

function generatorRounds(
  generator: RoundsCell,
  takeIds: readonly string[],
  cellsById: ReadonlyMap<string, RoundsCell>,
): GeneratorRounds {
  const rounds: NotebookRound[] = [];
  for (const takeId of [...takeIds].sort()) {
    const prompt = takePrompt(cellsById.get(takeId)!);
    const key = notebookPromptKey(prompt);
    const round = rounds.find((candidate) => candidate.key === key);
    if (round) round.takeIds.push(takeId);
    else rounds.push({ key, prompt, takeIds: [takeId] });
  }
  const current = notebookPromptKey(generator.prompt ?? "");
  return {
    generatorId: generator.id,
    rounds,
    currentRound: rounds.findIndex((round) => round.key === current),
  };
}

function bandOrder(rounds: GeneratorRounds): string {
  return rounds.rounds[0]?.takeIds[0] ?? `${NOT_RUN}${rounds.generatorId}`;
}

function orderedGenerators(
  document: RoundsDocument,
  cellsById: ReadonlyMap<string, RoundsCell>,
  takeOwner: ReadonlyMap<string, string>,
): GeneratorRounds[] {
  const takesBy = new Map<string, string[]>();
  for (const [takeId, generatorId] of takeOwner) {
    takesBy.set(generatorId, [...(takesBy.get(generatorId) ?? []), takeId]);
  }
  return document.cells
    .filter(isRoundsGenerator)
    .map((generator) => generatorRounds(generator, takesBy.get(generator.id) ?? [], cellsById))
    .sort((left, right) => compareIds(bandOrder(left), bandOrder(right)));
}

export function roundsTakeIds(rounds: GeneratorRounds): string[] {
  return rounds.rounds.flatMap((round) => round.takeIds);
}

function claimWalk(
  start: readonly string[],
  next: ReadonlyMap<string, readonly string[]>,
  claimable: (id: string) => boolean,
  claim: (id: string) => void,
): void {
  const queue = start.filter(claimable);
  queue.forEach(claim);
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const neighbour of next.get(id) ?? []) {
      if (!claimable(neighbour)) continue;
      claim(neighbour);
      queue.push(neighbour);
    }
  }
}

function claimBands(
  generators: readonly GeneratorRounds[],
  cellsById: ReadonlyMap<string, RoundsCell>,
  links: { parents: ReadonlyMap<string, readonly string[]>; children: ReadonlyMap<string, readonly string[]> },
  takeOwner: ReadonlyMap<string, string>,
): { bandOf: Map<string, string>; inputsOf: Map<string, string[]>; finishesOf: Map<string, string[]> } {
  const bandOf = new Map<string, string>(takeOwner);
  const inputsOf = new Map<string, string[]>();
  const finishesOf = new Map<string, string[]>();
  const claimable = (id: string) => {
    const cell = cellsById.get(id);
    return cell !== undefined && !bandOf.has(id) && !isRoundsGenerator(cell) && cell.type !== "timeline";
  };
  for (const generator of generators) bandOf.set(generator.generatorId, generator.generatorId);
  for (const generator of generators) {
    const band = generator.generatorId;
    const inputs: string[] = [];
    const finishes: string[] = [];
    claimWalk(links.parents.get(band) ?? [], links.parents, claimable, (id) => {
      bandOf.set(id, band);
      inputs.push(id);
    });
    claimWalk(roundsTakeIds(generator).flatMap((take) => links.children.get(take) ?? []), links.children, claimable, (id) => {
      bandOf.set(id, band);
      finishes.push(id);
    });
    inputsOf.set(band, inputs);
    finishesOf.set(band, finishes);
  }
  return { bandOf, inputsOf, finishesOf };
}

export function notebookRoundsModel(document: RoundsDocument): NotebookRoundsModel {
  const cellsById = new Map(document.cells.map((cell) => [cell.id, cell]));
  const links = roundsLinks(document, cellsById);
  const takeOwner = takeOwners(document, cellsById);
  const generators = orderedGenerators(document, cellsById, takeOwner);
  const claims = claimBands(generators, cellsById, links, takeOwner);
  return {
    cellsById,
    parents: links.parents,
    children: links.children,
    takeOwner,
    generators,
    ...claims,
  };
}

export function generatorRoundsOf(
  model: NotebookRoundsModel,
  generatorId: string,
): GeneratorRounds | undefined {
  return model.generators.find((rounds) => rounds.generatorId === generatorId);
}

export function isLinkedCell(model: NotebookRoundsModel, id: string): boolean {
  return (model.parents.get(id)?.length ?? 0) > 0 || (model.children.get(id)?.length ?? 0) > 0;
}

export interface RoundHeaderSlot {
  generatorId: string;
  round: number;
  slot: NotebookGridSlot;
}

export function notebookSlotKey(slot: NotebookGridSlot): string {
  return `${slot.row}:${slot.column}`;
}

function stackedColumn(cells: readonly RoundsCell[]): NotebookGridSlot | null {
  const column = cells[0]?.slot.column;
  if (column === undefined || cells.some((cell) => cell.slot.column !== column)) return null;
  const rows = cells.map((cell) => cell.slot.row).sort((left, right) => left - right);
  const contiguous = rows.every((row, index) => index === 0 || row === rows[index - 1]! + 1);
  return contiguous ? { row: rows[0]!, column } : null;
}

function roundHeaderSlot(
  model: NotebookRoundsModel,
  round: NotebookRound,
  taken: ReadonlySet<string>,
): NotebookGridSlot | null {
  const top = stackedColumn(round.takeIds.map((id) => model.cellsById.get(id)!));
  if (!top || top.row === 0) return null;
  const slot = { row: top.row - 1, column: top.column };
  return taken.has(notebookSlotKey(slot)) ? null : slot;
}

export function notebookRoundHeaderSlots(model: NotebookRoundsModel): RoundHeaderSlot[] {
  const taken = new Set(notebookOccupiedSlots([...model.cellsById.values()]).map(notebookSlotKey));
  const headers: RoundHeaderSlot[] = [];
  for (const rounds of model.generators.filter((candidate) => candidate.rounds.length > 1)) {
    rounds.rounds.forEach((round, index) => {
      const slot = roundHeaderSlot(model, round, taken);
      if (!slot) return;
      taken.add(notebookSlotKey(slot));
      headers.push({ generatorId: rounds.generatorId, round: index, slot });
    });
  }
  return headers;
}

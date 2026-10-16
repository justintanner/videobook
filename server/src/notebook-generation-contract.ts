import type { NotebookCell, NotebookDocument } from "videobook-engine";
import { generationModeInputError } from "./generation-input-policy.js";
import type { RefRole, ResolvedModel } from "./media/types.js";

type NotebookGenerationInputKind = "image" | "video" | "audio";

interface NotebookGenerationInputSlot {
  field: string;
  kind: NotebookGenerationInputKind;
  targets: string[];
  min: number;
  max: number | null;
}

interface NotebookGenerationInputMode {
  id: string;
  slots: NotebookGenerationInputSlot[];
  requiredGroups: string[][];
}

export interface NotebookGenerationInputContract {
  modes: NotebookGenerationInputMode[];
}

type ConnectedInput = {
  kind: NotebookGenerationInputKind;
  target: string;
};

function slotKind(role: RefRole): NotebookGenerationInputKind {
  if (role === "video") return "video";
  if (role === "audio") return "audio";
  return "image";
}

function modeSlots(model: ResolvedModel, roles: readonly RefRole[]): NotebookGenerationInputSlot[] {
  const slots = model.slots
    .filter((slot) => roles.includes(slot.role))
    .map((slot) => ({ field: slot.role, kind: slotKind(slot.role), targets: [slot.role], min: slot.min, max: slot.max }));
  return model.media === "video"
    ? [...slots, { field: "replace_audio", kind: "audio", targets: ["replace_audio"], min: 0, max: 1 }]
    : slots;
}

export function notebookGenerationInputContract(model: ResolvedModel): NotebookGenerationInputContract {
  return {
    modes: model.modes.map((mode) => ({
      id: mode.id,
      slots: modeSlots(model, mode.roles),
      requiredGroups: mode.requireAny && mode.requireAny.length > 0 ? [[...mode.requireAny]] : [],
    })),
  };
}

function cellInputKind(cell: NotebookCell): NotebookGenerationInputKind | null {
  if (
    cell.type === "image"
    || cell.type === "generate_image"
  ) return "image";
  if (
    cell.type === "video"
    || cell.type === "split_video"
    || cell.type === "generate_video"
    || cell.type === "concat"
    || cell.type === "splice"
  ) return "video";
  if (
    cell.type === "audio"
    || cell.type === "extract_audio"
    || cell.type === "generate_audio"
  ) return "audio";
  return null;
}

function connectedInputTarget(
  kind: NotebookGenerationInputKind,
  targetInput: string,
): string {
  if (targetInput === "first_frame" || targetInput === "last_frame") {
    return targetInput;
  }
  if (kind === "audio" && targetInput === "replace_audio") {
    return targetInput;
  }
  return kind;
}

function connectedInputs(
  document: NotebookDocument,
  cell: NotebookCell,
): ConnectedInput[] {
  const cells = new Map(document.cells.map((candidate) => [candidate.id, candidate]));
  return document.edges.flatMap((edge) => {
    if (edge.target !== cell.id) return [];
    const source = cells.get(edge.source);
    const kind = source ? cellInputKind(source) : null;
    return kind
      ? [{ kind, target: connectedInputTarget(kind, edge.targetInput) }]
      : [];
  });
}

export function notebookGenerationInputsAreCompatible(
  contract: NotebookGenerationInputContract,
  document: NotebookDocument,
  cell: NotebookCell,
  modeId?: string,
): boolean {
  const inputs = connectedInputs(document, cell);
  const configuredModes = modeId
    ? contract.modes.filter((candidate) => candidate.id === modeId)
    : contract.modes;
  const modes = modeId === "default" && configuredModes.length === 0
    ? contract.modes
    : configuredModes;
  return modes.some((candidate) => generationModeInputError(candidate, inputs) === null);
}

export function notebookGenerationInputError(
  contract: NotebookGenerationInputContract,
  document: NotebookDocument,
  cell: NotebookCell,
  modeId?: string,
): string | null {
  const candidate = contract.modes.find((mode) => mode.id === modeId)
    ?? (contract.modes.length === 1 ? contract.modes[0] : undefined);
  return candidate ? generationModeInputError(candidate, connectedInputs(document, cell)) : null;
}

import type { NotebookCell, NotebookDocument } from "videobook-engine";
import { generationModeInputError } from "./generation-input-policy.js";
import { generationInputTarget } from "./generation-input-targets.js";
import type { InputLimit, ItemParamSpec, RefRole, ResolvedModel } from "./media/types.js";

type NotebookGenerationInputKind = "image" | "video" | "audio";

interface NotebookGenerationInputSlot {
  field: string;
  kind: NotebookGenerationInputKind;
  targets: string[];
  min: number;
  max: number | null;
}

export interface NotebookGenerationInputField {
  path: string;
  label: string;
  max: number | null;
}

export interface NotebookGenerationInputSpec {
  target: string;
  kind: NotebookGenerationInputKind;
  label: string;
  fields: NotebookGenerationInputField[];
  min: number;
  max: number | null;
  token: string | null;
  itemParams: readonly ItemParamSpec[];
  sent: boolean;
}

export interface NotebookGenerationInputMode {
  id: string;
  slots: NotebookGenerationInputSlot[];
  requiredGroups: string[][];
  label: string;
  inputs: NotebookGenerationInputSpec[];
  limits: readonly InputLimit[];
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

const INPUT_ORDER: readonly RefRole[] = ["image", "first_frame", "last_frame", "loop", "keyframe", "video", "audio"];

const TOKEN_FAMILY: Readonly<Record<RefRole, string>> = {
  image: "image",
  video: "video",
  audio: "audio",
  first_frame: "firstframe",
  last_frame: "lastframe",
  loop: "loop",
  keyframe: "keyframe",
};

const REPLACE_AUDIO_INPUT: NotebookGenerationInputSpec = {
  target: "replace_audio",
  kind: "audio",
  label: "Replacement audio",
  fields: [],
  min: 0,
  max: 1,
  token: null,
  itemParams: [],
  sent: false,
};

function modeInputSpecs(model: ResolvedModel, roles: readonly RefRole[]): NotebookGenerationInputSpec[] {
  const inputs = INPUT_ORDER.flatMap((role) => {
    const slot = roles.includes(role) ? model.slots.find((candidate) => candidate.role === role) : undefined;
    return slot
      ? [{
          target: slot.role,
          kind: slot.kind,
          label: slot.label,
          fields: slot.fields.map(({ path, label, max }) => ({ path, label, max })),
          min: slot.min,
          max: slot.max,
          token: TOKEN_FAMILY[slot.role],
          itemParams: slot.itemParams,
          sent: true,
        }]
      : [];
  });
  return model.media === "video" ? [...inputs, REPLACE_AUDIO_INPUT] : inputs;
}

function modeLimits(model: ResolvedModel, roles: readonly RefRole[]): readonly InputLimit[] {
  return (model.entry.inputLimits ?? []).filter((limit) => limit.kind === "requires"
    ? roles.includes(limit.role)
    : limit.roles.some((entry) => roles.includes(entry.role)));
}

export function notebookGenerationInputContract(model: ResolvedModel): NotebookGenerationInputContract {
  return {
    modes: model.modes.map((mode) => ({
      id: mode.id,
      slots: modeSlots(model, mode.roles),
      requiredGroups: mode.requireAny && mode.requireAny.length > 0 ? [[...mode.requireAny]] : [],
      label: mode.label,
      inputs: modeInputSpecs(model, mode.roles),
      limits: modeLimits(model, mode.roles),
    })),
  };
}

export function notebookGenerationInputKind(cell: Pick<NotebookCell, "type">): NotebookGenerationInputKind | null {
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

function connectedInputs(
  document: NotebookDocument,
  cell: NotebookCell,
): ConnectedInput[] {
  const cells = new Map(document.cells.map((candidate) => [candidate.id, candidate]));
  return document.edges.flatMap((edge) => {
    if (edge.target !== cell.id) return [];
    const source = cells.get(edge.source);
    const kind = source ? notebookGenerationInputKind(source) : null;
    return kind
      ? [{ kind, target: generationInputTarget(kind, edge.targetInput) }]
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

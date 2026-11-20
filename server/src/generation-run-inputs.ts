import type { NotebookDocument } from "videobook-engine";
import { resolveModel } from "./media/descriptor.js";
import { REF_ROLES, type RefRole } from "./media/types.js";

type GenerationRunInputKind = "image" | "video" | "audio";

export type GenerationRunInput = {
  slot: string;
  kind: GenerationRunInputKind;
  artifactId: string;
  sourceCellId: string | null;
};

type RequestRecord = Record<string, unknown>;

const ROLE_KINDS: Readonly<Record<RefRole, GenerationRunInputKind>> = {
  first_frame: "image",
  last_frame: "image",
  loop: "image",
  keyframe: "image",
  image: "image",
  video: "video",
  audio: "audio",
};

const SINGLE_ROLE_TOKENS: Partial<Record<RefRole, string>> = {
  first_frame: "firstframe",
  last_frame: "lastframe",
  loop: "loop",
};

function recordOf(value: unknown): RequestRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RequestRecord
    : null;
}

function artifactIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
}

function roleSlot(role: RefRole, index: number): string {
  const single = SINGLE_ROLE_TOKENS[role];
  if (single) return index === 0 ? `@${single}` : `@${single}${index + 1}`;
  return `@${role}${index + 1}`;
}

type FieldLabel = { label: string; kind: GenerationRunInputKind };

function fieldLabels(model: unknown): ReadonlyMap<string, FieldLabel> {
  if (typeof model !== "string") return new Map();
  try {
    return new Map(resolveModel(model).fieldSlots.map((slot) => [slot.field, { label: slot.label, kind: slot.kind }]));
  } catch {
    return new Map();
  }
}

function fallbackFieldLabel(field: string): string {
  const words = field.replaceAll("_", " ").trim();
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : field;
}

function cellHolding(document: NotebookDocument, artifactId: string): string | null {
  const current = document.cells.find((cell) =>
    cell.outputArtifactId === artifactId || cell.outputEntityId === artifactId);
  if (current) return current.id;
  const earlier = document.cells.find((cell) =>
    artifactIds(cell.inputs?.outputVersionArtifactIds).includes(artifactId));
  return earlier?.id ?? null;
}

function roleInputs(refs: RequestRecord | null): Array<Omit<GenerationRunInput, "sourceCellId">> {
  if (!refs) return [];
  return REF_ROLES.flatMap((role) => artifactIds(refs[role]).map((artifactId, index) => ({
    slot: roleSlot(role, index),
    kind: ROLE_KINDS[role],
    artifactId,
  })));
}

function fieldInputs(fieldRefs: RequestRecord | null, model: unknown): Array<Omit<GenerationRunInput, "sourceCellId">> {
  if (!fieldRefs) return [];
  const labels = fieldLabels(model);
  return Object.entries(fieldRefs).flatMap(([field, value]) => {
    const ids = artifactIds(value);
    const known = labels.get(field);
    const label = known?.label ?? fallbackFieldLabel(field);
    return ids.map((artifactId, index) => ({
      slot: ids.length > 1 ? `${label} ${index + 1}` : label,
      kind: known?.kind ?? "image",
      artifactId,
    }));
  });
}

export function generationRunInputs(
  request: unknown,
  document: NotebookDocument,
): GenerationRunInput[] {
  const record = recordOf(request);
  if (!record) return [];
  const replacement = typeof record.replaceAudioWith === "string" && record.replaceAudioWith
    ? [{ slot: "Replacement audio", kind: "audio" as const, artifactId: record.replaceAudioWith }]
    : [];
  return [
    ...roleInputs(recordOf(record.refs)),
    ...fieldInputs(recordOf(record.fieldRefs), record.model),
    ...replacement,
  ].map((input) => ({ ...input, sourceCellId: cellHolding(document, input.artifactId) }));
}

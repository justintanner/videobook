export type LegacyInputKind = "image" | "video" | "audio";

export interface LegacyCell {
  id: string;
  type: string;
  inputs?: Record<string, unknown>;
}

export interface LegacyEdge {
  source: string;
  target: string;
  targetInput: string;
}

export interface LegacyMention {
  token: string;
  kind: LegacyInputKind;
  sourceCellId: string;
  targetInput: string;
}

const FRAME_TARGETS = new Set(["first_frame", "last_frame", "loop"]);
const KEYFRAME_TARGET = /^keyframe(?:_\d+)?$/u;

export function legacyGenerationInputTarget(kind: LegacyInputKind, targetInput: string): string {
  if (FRAME_TARGETS.has(targetInput)) return targetInput;
  if (KEYFRAME_TARGET.test(targetInput)) return "keyframe";
  if (kind === "audio" && targetInput === "replace_audio") return targetInput;
  return kind;
}

export function legacyGenerationModeInputTarget(
  modeId: string | undefined,
  kind: LegacyInputKind,
  target: string,
): string {
  return modeId === "r2v" && kind === "image"
    && (target === "first_frame" || target === "last_frame")
    ? "image"
    : target;
}

const FRAME_TOKENS: Readonly<Record<string, string>> = {
  first_frame: "firstframe",
  last_frame: "lastframe",
  loop: "loop",
};

const UNNAMED_TARGET_INPUTS = new Set(["replace_audio"]);

const KIND_ORDER: readonly LegacyInputKind[] = ["image", "video", "audio"];

function legacyMediaKind(cellType: string): LegacyInputKind | null {
  if (cellType === "image" || cellType === "generate_image") return "image";
  if (
    cellType === "audio"
    || cellType === "extract_audio"
    || cellType === "generate_audio"
  ) return "audio";
  if (
    cellType === "video"
    || cellType === "split_video"
    || cellType === "generate_video"
    || cellType === "concat"
    || cellType === "splice"
  ) return "video";
  return null;
}

function legacyNumberedKindSlotIndex(targetInput: string, kind: string): number | null {
  if (targetInput === kind) return 1;
  const prefix = `${kind}_`;
  if (!targetInput.startsWith(prefix)) return null;
  const suffix = targetInput.slice(prefix.length);
  if (!/^\d+$/.test(suffix)) return null;
  return Number(suffix);
}

export function legacySortByKindSlot<T extends { targetInput: string }>(
  entries: readonly T[],
  kind: string,
): T[] {
  return [...entries].sort((left, right) => {
    const leftIndex = legacyNumberedKindSlotIndex(left.targetInput, kind) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = legacyNumberedKindSlotIndex(right.targetInput, kind) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
}

interface LegacyKindedInput {
  kind: LegacyInputKind;
  sourceCellId: string;
  targetInput: string;
}

function legacyConnectedInputs(
  cellId: string,
  cells: readonly LegacyCell[],
  edges: readonly LegacyEdge[],
): LegacyKindedInput[] {
  const cellsById = new Map(cells.map((cell) => [cell.id, cell]));
  return edges.flatMap((edge) => {
    if (edge.target !== cellId) return [];
    const source = cellsById.get(edge.source);
    const kind = source ? legacyMediaKind(source.type) : null;
    return kind ? [{ kind, sourceCellId: edge.source, targetInput: edge.targetInput }] : [];
  });
}

function legacyFrameMentions(inputs: readonly LegacyKindedInput[]): LegacyMention[] {
  return Object.entries(FRAME_TOKENS).flatMap(([targetInput, token]) => {
    const input = inputs.find((candidate) => candidate.kind === "image" && candidate.targetInput === targetInput);
    return input ? [{ ...input, token }] : [];
  });
}

function legacyIsKeyframeInput(input: LegacyKindedInput): boolean {
  return input.kind === "image" && legacyGenerationInputTarget(input.kind, input.targetInput) === "keyframe";
}

function legacyKeyframeMentions(inputs: readonly LegacyKindedInput[]): LegacyMention[] {
  return legacySortByKindSlot(inputs.filter(legacyIsKeyframeInput), "keyframe").map((input, index) => ({
    ...input,
    token: `keyframe${index + 1}`,
  }));
}

function legacyNumberedMentions(
  inputs: readonly LegacyKindedInput[],
  kind: LegacyInputKind,
  modeId?: string,
): LegacyMention[] {
  const named = inputs.filter((input) =>
    input.kind === kind
    && !(modeId !== "r2v" && kind === "image" && input.targetInput in FRAME_TOKENS)
    && !legacyIsKeyframeInput(input)
    && !UNNAMED_TARGET_INPUTS.has(input.targetInput));
  return legacySortByKindSlot(named, kind).map((input, index) => ({
    ...input,
    token: `${kind}${index + 1}`,
  }));
}

export function legacyGenerationInputMentions(
  cellId: string,
  cells: readonly LegacyCell[],
  edges: readonly LegacyEdge[],
  modeId?: string,
): LegacyMention[] {
  const configuredMode = cells.find((cell) => cell.id === cellId)?.inputs?.generationMode;
  const effectiveMode = modeId ?? configuredMode;
  const inputs = legacyConnectedInputs(cellId, cells, edges);
  return [
    ...(effectiveMode === "r2v" ? [] : [...legacyFrameMentions(inputs), ...legacyKeyframeMentions(inputs)]),
    ...KIND_ORDER.flatMap((kind) => legacyNumberedMentions(
      inputs, kind, typeof effectiveMode === "string" ? effectiveMode : undefined,
    )),
  ];
}

export function legacyRemapGenerationInputPrompt(
  prompt: string,
  previous: readonly LegacyMention[],
  next: readonly LegacyMention[],
): string {
  const used = new Set([...previous, ...next].map((mention) => mention.token));
  const replacements = new Map(previous.map((before) => {
    const after = next.find((candidate) => candidate.sourceCellId === before.sourceCellId
      && candidate.targetInput === before.targetInput)
      ?? next.find((candidate) => candidate.targetInput === before.targetInput);
    if (after) return [before.token, after.token];
    if (!next.some((candidate) => candidate.token === before.token)) return [before.token, before.token];
    const family = /^keyframe\d+$/u.test(before.token) ? "keyframe" : before.kind;
    let index = 1;
    while (used.has(`${family}${index}`)) index += 1;
    const missing = `${family}${index}`;
    used.add(missing);
    return [before.token, missing];
  }));
  return prompt.replace(/@((?:image|video|audio|keyframe)\d+|firstframe|lastframe|loop)(?![\w-])/giu,
    (match, token: string) => {
      const replacement = replacements.get(token.toLowerCase());
      return replacement && replacement !== token.toLowerCase() ? `@${replacement}` : match;
    });
}

export function legacyScanGenerationInputTokens(prompt: string): string[] {
  return [...prompt.matchAll(/@((?:image|video|audio|keyframe)\d+|firstframe|lastframe|loop)(?![\w-])/giu)]
    .map((match) => match[1]!.toLowerCase());
}

function legacyReferenceKind(type: string): LegacyInputKind | null {
  if (type === "image" || type === "generate_image") return "image";
  if (
    type === "video"
    || type === "split_video"
    || type === "generate_video"
    || type === "concat"
    || type === "splice"
  ) return "video";
  if (type === "audio" || type === "extract_audio" || type === "generate_audio") return "audio";
  return null;
}

function legacyNextNotebookReferenceInput(
  edges: readonly LegacyEdge[],
  targetId: string,
  kind: LegacyInputKind | "keyframe",
): string {
  const occupied = new Set(edges.filter((edge) => edge.target === targetId).map((edge) => edge.targetInput));
  if (!occupied.has(kind)) return kind;
  for (let ordinal = 2; ; ordinal += 1) {
    const input = `${kind}_${ordinal}`;
    if (!occupied.has(input)) return input;
  }
}

export function legacyNotebookConnectionTargetInput(
  cells: readonly LegacyCell[],
  edges: readonly LegacyEdge[],
  connection: { source: string; target: string; targetHandle?: string | null },
): string {
  const requestedInput = connection.targetHandle ?? "input";
  const source = cells.find((cell) => cell.id === connection.source);
  const target = cells.find((cell) => cell.id === connection.target);
  const accepts = target?.type === "generate_image" || target?.type === "generate_video" || target?.type === "generate_audio";
  if (!source || !target || !accepts) return requestedInput;
  const kind = legacyReferenceKind(source.type);
  if (!kind) return requestedInput;
  if (kind === "image" && (requestedInput === "first_frame" || requestedInput === "last_frame" || requestedInput === "loop")) {
    return requestedInput;
  }
  if (kind === "image" && legacyGenerationInputTarget(kind, requestedInput) === "keyframe") {
    return legacyNextNotebookReferenceInput(edges, target.id, "keyframe");
  }
  if (kind === "audio" && (requestedInput === "replace_audio" || requestedInput === "scene_audio")) return requestedInput;
  return legacyNextNotebookReferenceInput(edges, target.id, kind);
}

export function legacyNextGenerationTargetInput(target: string, usedTargetInputs: ReadonlySet<string>): string {
  if (!usedTargetInputs.has(target)) return target;
  let index = 2;
  while (usedTargetInputs.has(`${target}_${index}`)) index += 1;
  return `${target}_${index}`;
}

export function legacyUniqueConnectionTargets(inputs: readonly { target: string }[]): string[] {
  const counts = new Map<string, number>();
  return inputs.map((input) => {
    const count = (counts.get(input.target) ?? 0) + 1;
    counts.set(input.target, count);
    return count === 1 ? input.target : `${input.target}_${count}`;
  });
}

export function legacyPinTargetInput(pin: { field: string; index: number | null }): string {
  const role = pin.field.split(".").pop() ?? pin.field;
  const field = role === "replace_audio_with" ? "replace_audio" : role;
  return pin.index === null || pin.index === 0 ? field : `${field}_${pin.index + 1}`;
}

export const LEGACY_SLOT_TOKEN_SOURCE = "@((image|video|audio|keyframe)(\\d+)|firstframe|lastframe|loop)(?![\\w-])";

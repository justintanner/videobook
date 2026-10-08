// Generation prompts name their media by input slot, never by grid square:
// "@image1" is the first connected image input, whatever square it sits in, so
// moving cells around the grid leaves the prompt untouched. The numbering is
// the order the server hands media to the provider (image_refs, video_refs,
// audio_refs), so "@image2" in the prompt and "reference image 2" in the
// payload always mean the same asset. Frame inputs ride their own params and
// get their own tokens.
//
// Pure and dependency-free: the client imports it for the autocomplete menu
// and the input cards, the server for prompt resolution.

export type GenerationInputMediaKind = "image" | "video" | "audio";

export interface GenerationInputMentionCell {
  id: string;
  type: string;
  inputs?: Record<string, unknown>;
}

export interface GenerationInputMentionEdge {
  source: string;
  target: string;
  targetInput: string;
}

export interface GenerationInputMention {
  /** Token without the leading "@", e.g. "image1" or "firstframe". */
  token: string;
  kind: GenerationInputMediaKind;
  sourceCellId: string;
  targetInput: string;
}

const FRAME_TOKENS: Readonly<Record<string, string>> = {
  first_frame: "firstframe",
  last_frame: "lastframe",
};

// Inputs that feed a dedicated provider param and cannot be named inline.
const UNNAMED_TARGET_INPUTS = new Set(["replace_audio"]);

const KIND_ORDER: readonly GenerationInputMediaKind[] = ["image", "video", "audio"];

function generationInputMediaKind(
  cellType: string,
): GenerationInputMediaKind | null {
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

function numberedKindSlotIndex(
  targetInput: string,
  kind: GenerationInputMediaKind,
): number | null {
  if (targetInput === kind) return 1;
  const prefix = `${kind}_`;
  if (!targetInput.startsWith(prefix)) return null;
  const suffix = targetInput.slice(prefix.length);
  if (!/^\d+$/.test(suffix)) return null;
  return Number(suffix);
}

/** Stable sort by numbered slot ("image", "image_2", …); unnumbered last. */
export function sortByKindSlot<T extends { targetInput: string }>(
  entries: readonly T[],
  kind: GenerationInputMediaKind,
): T[] {
  return [...entries].sort((left, right) => {
    const leftIndex = numberedKindSlotIndex(left.targetInput, kind)
      ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = numberedKindSlotIndex(right.targetInput, kind)
      ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
}

interface KindedInput {
  kind: GenerationInputMediaKind;
  sourceCellId: string;
  targetInput: string;
}

function connectedInputs(
  cellId: string,
  cells: readonly GenerationInputMentionCell[],
  edges: readonly GenerationInputMentionEdge[],
): KindedInput[] {
  const cellsById = new Map(cells.map((cell) => [cell.id, cell]));
  return edges.flatMap((edge) => {
    if (edge.target !== cellId) return [];
    const source = cellsById.get(edge.source);
    const kind = source ? generationInputMediaKind(source.type) : null;
    return kind
      ? [{ kind, sourceCellId: edge.source, targetInput: edge.targetInput }]
      : [];
  });
}

function frameMentions(inputs: readonly KindedInput[]): GenerationInputMention[] {
  return Object.entries(FRAME_TOKENS).flatMap(([targetInput, token]) => {
    const input = inputs.find((candidate) =>
      candidate.kind === "image" && candidate.targetInput === targetInput);
    return input ? [{ ...input, token }] : [];
  });
}

function numberedMentions(
  inputs: readonly KindedInput[],
  kind: GenerationInputMediaKind,
  modeId?: string,
): GenerationInputMention[] {
  const named = inputs.filter((input) =>
    input.kind === kind
    && !(modeId !== "r2v" && kind === "image" && input.targetInput in FRAME_TOKENS)
    && !UNNAMED_TARGET_INPUTS.has(input.targetInput));
  return sortByKindSlot(named, kind).map((input, index) => ({
    ...input,
    token: `${kind}${index + 1}`,
  }));
}

/** Every prompt-nameable input of a generation cell, in provider order. */
export function generationInputMentions(
  cellId: string,
  cells: readonly GenerationInputMentionCell[],
  edges: readonly GenerationInputMentionEdge[],
  modeId?: string,
): GenerationInputMention[] {
  const configuredMode = cells.find((cell) => cell.id === cellId)?.inputs?.generationMode;
  const effectiveMode = modeId ?? configuredMode;
  const inputs = connectedInputs(cellId, cells, edges);
  return [
    ...(effectiveMode === "r2v" ? [] : frameMentions(inputs)),
    ...KIND_ORDER.flatMap((kind) => numberedMentions(
      inputs, kind, typeof effectiveMode === "string" ? effectiveMode : undefined,
    )),
  ];
}

export function remapGenerationInputPrompt(
  prompt: string,
  previous: readonly GenerationInputMention[],
  next: readonly GenerationInputMention[],
): string {
  const used = new Set([...previous, ...next].map((mention) => mention.token));
  const replacements = new Map(previous.map((before) => {
    const after = next.find((candidate) => candidate.sourceCellId === before.sourceCellId
      && candidate.targetInput === before.targetInput)
      ?? next.find((candidate) => candidate.targetInput === before.targetInput);
    if (after) return [before.token, after.token];
    if (!next.some((candidate) => candidate.token === before.token)) return [before.token, before.token];
    let index = 1;
    while (used.has(`${before.kind}${index}`)) index += 1;
    const missing = `${before.kind}${index}`;
    used.add(missing);
    return [before.token, missing];
  }));
  return prompt.replace(/@((?:image|video|audio)\d+|firstframe|lastframe)(?![\w-])/giu,
    (match, token: string) => {
      const replacement = replacements.get(token.toLowerCase());
      return replacement && replacement !== token.toLowerCase() ? `@${replacement}` : match;
    });
}

/** "@image1"-style tokens in a prompt, lower-cased and without the "@". */
export function scanGenerationInputTokens(prompt: string): string[] {
  return [...prompt.matchAll(/@((?:image|video|audio)\d+|firstframe|lastframe)(?![\w-])/giu)]
    .map((match) => match[1]!.toLowerCase());
}

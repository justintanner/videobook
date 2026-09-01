import type { NotebookCell, NotebookDocument } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import { NOTEBOOK_GRID_ADDRESS_SOURCE } from "videobook-engine/notebook-mentions";

const INITIAL_PROMPT_KEY = "initialGenerationPrompt";
const INITIAL_PROMPT_VERSION = 1;

type GenerationKind = "image" | "video";
type MediaKind = "audio" | "image" | "video";

type InitialPromptRecord = {
  prompt: string;
  version: number;
};

type PromptInput = {
  cell: NotebookCell;
  cue: string | null;
  kind: MediaKind;
  targetInput: string;
};

function generationKind(cell: NotebookCell): GenerationKind | null {
  if (cell.type === "generate_image") return "image";
  if (cell.type === "generate_video") return "video";
  return null;
}

function mediaKind(cell: NotebookCell): MediaKind | null {
  if (cell.type === "image" || cell.type === "generate_image") return "image";
  if (
    cell.type === "video"
    || cell.type === "generate_video"
    || cell.type === "split_video"
    || cell.type === "concat"
    || cell.type === "splice"
  ) return "video";
  if (
    cell.type === "audio"
    || cell.type === "generate_audio"
    || cell.type === "extract_audio"
  ) return "audio";
  return null;
}

function initialPromptRecord(cell: NotebookCell): InitialPromptRecord | null {
  const value = cell.inputs?.[INITIAL_PROMPT_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return typeof record.prompt === "string"
    && typeof record.version === "number"
    ? { prompt: record.prompt, version: record.version }
    : null;
}

function cleanCue(value: string | undefined): string | null {
  const cue = value
    ?.replace(new RegExp(` ?@${NOTEBOOK_GRID_ADDRESS_SOURCE}(?![\\w-])`, "giu"), "")
    .replace(
      / ?@[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\w-])/giu,
      "",
    )
    .replace(/\s+/gu, " ")
    .trim()
    .replace(
      /^(?:please\s+)?(?:create|generate|make|render)\s+(?:(?:a|an|the)\s+)?(?:(?:image|video|picture|photo|clip)\s+)?(?:of\s+)?/iu,
      "",
    )
    .replace(/^(?:a|an|the)\s+/iu, "")
    .replace(/[.!?]+$/u, "")
    .trim();
  return cue || null;
}

function cellPrompt(cell: NotebookCell): string | undefined {
  if (cell.prompt?.trim()) return cell.prompt;
  const resolved = cell.inputs?.resolvedPrompt;
  if (typeof resolved === "string" && resolved.trim()) return resolved;
  return undefined;
}

function promptInputs(
  document: NotebookDocument,
  cell: NotebookCell,
): PromptInput[] {
  const cells = new Map(document.cells.map((candidate) => [candidate.id, candidate]));
  const targetOrder = new Map([
    ["first_frame", 0],
    ["last_frame", 1],
    ["image", 2],
    ["video", 3],
    ["audio", 4],
    ["replace_audio", 5],
  ]);
  return document.edges
    .filter((edge) => edge.target === cell.id && edge.targetInput !== "media")
    .flatMap((edge) => {
      const source = cells.get(edge.source);
      const kind = source ? mediaKind(source) : null;
      const producerId = source?.inputs?.producerCellId;
      const producer = typeof producerId === "string"
        ? cells.get(producerId)
        : undefined;
      return source && kind
        ? [{
            cell: source,
            cue: cleanCue(cellPrompt(producer ?? source) ?? cellPrompt(source)),
            kind,
            targetInput: edge.targetInput,
          }]
        : [];
    })
    .sort((left, right) => {
      const targetDifference = (targetOrder.get(left.targetInput) ?? 99)
        - (targetOrder.get(right.targetInput) ?? 99);
      if (targetDifference !== 0) return targetDifference;
      if (left.cell.slot.row !== right.cell.slot.row) {
        return left.cell.slot.row - right.cell.slot.row;
      }
      return left.cell.slot.column - right.cell.slot.column;
    });
}

function inputRole(
  generation: GenerationKind,
  input: PromptInput,
): string {
  if (input.targetInput === "first_frame") return "Start frame";
  if (input.targetInput === "last_frame") return "End frame";
  if (input.targetInput === "replace_audio") return "Replacement audio";
  if (input.kind === "image") {
    return generation === "video" ? "Subject image" : "Reference image";
  }
  if (input.kind === "video") {
    return generation === "video" ? "Motion video" : "Scene video";
  }
  if (input.kind === "audio") return "Audio";
  return "Source";
}

function describeInput(
  generation: GenerationKind,
  input: PromptInput,
): string {
  return `${inputRole(generation, input)} ${notebookGridTag(input.cell.slot)}`
    + `${input.cue ? `: ${input.cue}` : ""}.`;
}

function fallbackPrompt(kind: GenerationKind): string {
  if (kind === "image") return "Clear subject, coherent scene.";
  return "Clear subject, coherent motion.";
}

function buildInitialGenerationPrompt(
  document: NotebookDocument,
  cell: NotebookCell,
): string {
  const kind = generationKind(cell);
  if (!kind) return cell.prompt?.trim() ?? "";
  const inputs = promptInputs(document, cell);
  if (inputs.length === 0) return fallbackPrompt(kind);
  const descriptions = inputs.map((input) => describeInput(kind, input));
  if (kind === "image") {
    return [
      ...descriptions,
      "Preserve subject, composition.",
      "Render clean image.",
    ].join(" ");
  }
  const directives: string[] = [];
  const firstFrame = inputs.some((input) => input.targetInput === "first_frame");
  const lastFrame = inputs.some((input) => input.targetInput === "last_frame");
  const hasImage = inputs.some((input) => input.kind === "image");
  const hasVideo = inputs.some((input) => input.kind === "video");
  const hasAudio = inputs.some((input) => input.kind === "audio");
  if (firstFrame && lastFrame) directives.push("Animate smooth frame transition.");
  else if (hasImage) directives.push("Animate subject.");
  if (hasVideo) directives.push("Match motion, timing.");
  if (hasAudio) directives.push("Sync action, timing.");
  if (hasImage) directives.push("Preserve identity, composition.");
  directives.push("Render coherent video.");
  return [...descriptions, ...directives].join(" ");
}

export function resolvedInitialGenerationPrompt(
  document: NotebookDocument,
  cell: NotebookCell,
): string {
  const prompt = cell.prompt?.trim() ?? "";
  const record = initialPromptRecord(cell);
  if (record && prompt === record.prompt.trim()) {
    return buildInitialGenerationPrompt(document, cell);
  }
  return prompt || buildInitialGenerationPrompt(document, cell);
}

export function seedInitialGenerationPrompt(
  document: NotebookDocument,
  cellId: string,
): NotebookDocument {
  const target = document.cells.find((cell) => cell.id === cellId);
  if (!target || !generationKind(target)) return document;
  const record = initialPromptRecord(target);
  const currentPrompt = target.prompt?.trim() ?? "";
  if (currentPrompt && (!record || currentPrompt !== record.prompt.trim())) {
    return document;
  }
  const prompt = buildInitialGenerationPrompt(document, target);
  if (
    currentPrompt === prompt
    && record?.prompt === prompt
    && record.version === INITIAL_PROMPT_VERSION
  ) return document;
  return {
    ...document,
    cells: document.cells.map((cell) => cell.id === cellId
      ? {
          ...cell,
          prompt,
          inputs: {
            ...(cell.inputs ?? {}),
            [INITIAL_PROMPT_KEY]: {
              prompt,
              version: INITIAL_PROMPT_VERSION,
            },
          },
        }
      : cell),
  };
}

export function refreshInitialGenerationPrompts(
  document: NotebookDocument,
): NotebookDocument {
  return document.cells.reduce(
    (current, cell) => initialPromptRecord(cell)
      ? seedInitialGenerationPrompt(current, cell.id)
      : current,
    document,
  );
}

export function reconcileInitialGenerationPrompt(
  previous: NotebookCell,
  next: NotebookCell,
): NotebookCell {
  const record = initialPromptRecord(next) ?? initialPromptRecord(previous);
  if (!record) return next;
  if ((next.prompt?.trim() ?? "") === record.prompt.trim()) {
    return initialPromptRecord(next)
      ? next
      : {
          ...next,
          inputs: {
            ...(next.inputs ?? {}),
            [INITIAL_PROMPT_KEY]: record,
          },
        };
  }
  const inputs = { ...(next.inputs ?? {}) };
  delete inputs[INITIAL_PROMPT_KEY];
  return { ...next, inputs };
}

import type { Engine, NotebookCell } from "videobook-engine";
import { isDubVideoModel } from "./dub-video.js";
import { logger } from "./logger.js";
import { tryResolveModel } from "./media/descriptor.js";
import type { Operation } from "./media/types.js";

export type GenerationModelMedia = "image" | "video";

export type GenerationModelMemory = Partial<Record<GenerationModelMedia, string>>;

const MEMORY_KEY = "generation-model-memory";

const REMEMBERED_OPERATIONS: Readonly<Record<GenerationModelMedia, ReadonlySet<Operation>>> = {
  image: new Set(["text_to_image", "edit_image"]),
  video: new Set(["text_to_video", "image_to_video", "reference_to_video", "edit_video"]),
};

export function generationModelMedia(cellType: string): GenerationModelMedia | null {
  if (cellType === "generate_image") return "image";
  if (cellType === "generate_video") return "video";
  return null;
}

export function readGenerationModelMemory(engine: Engine): GenerationModelMemory {
  const stored = engine.settings.get<Record<string, unknown>>(MEMORY_KEY);
  const memory: GenerationModelMemory = {};
  for (const media of ["image", "video"] as const) {
    const model = stored?.[media];
    if (typeof model === "string" && model.trim() !== "") memory[media] = model;
  }
  return memory;
}

function rememberedModelId(cell: NotebookCell): { media: GenerationModelMedia; model: string } | null {
  const media = generationModelMedia(cell.type);
  if (!media || !cell.model || (cell.tool && cell.tool !== `generate_${media}`)) return null;
  const model = tryResolveModel(cell.model);
  if (!model || model.media !== media || isDubVideoModel(model.id)) return null;
  if (!model.entry.operations.some((operation) => REMEMBERED_OPERATIONS[media].has(operation))) return null;
  return { media, model: model.id };
}

export function rememberGenerationModel(engine: Engine, cell: NotebookCell): void {
  const remembered = rememberedModelId(cell);
  if (!remembered) return;
  const current = readGenerationModelMemory(engine);
  if (current[remembered.media] === remembered.model) return;
  const written = engine.settings.set(MEMORY_KEY, { ...current, [remembered.media]: remembered.model });
  if (!written.ok) logger.warn("generation-model-memory-write-failed", { error: written.error });
}

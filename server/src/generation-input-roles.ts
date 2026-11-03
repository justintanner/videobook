import { REF_ROLES, type RefRole } from "./media/types.js";
import {
  generationInputTarget,
  isGenerationFieldPort,
  sortByGenerationInputPort,
  type GenerationInputKind,
} from "./generation-input-targets.js";

export interface GenerationRoleEntry {
  targetInput: string;
  kind: GenerationInputKind;
}

export type GenerationInputRoles<T extends GenerationRoleEntry> = Partial<Record<RefRole, T[]>>;

function frameEntry<T extends GenerationRoleEntry>(entries: readonly T[], target: string, mode: string | undefined): T | undefined {
  return mode === "r2v"
    ? undefined
    : entries.find((entry) => entry.targetInput === target && entry.kind === "image");
}

function imageEntries<T extends GenerationRoleEntry>(entries: readonly T[], mode: string | undefined): T[] {
  return sortByGenerationInputPort(entries.filter(({ kind, targetInput }) => {
    if (kind !== "image") return false;
    const target = generationInputTarget("image", targetInput);
    return target === "image" || (mode === "r2v" && (target === "first_frame" || target === "last_frame"));
  }), "image");
}

export function generationInputRoles<T extends GenerationRoleEntry>(
  connected: readonly T[],
  modeRoles: ReadonlySet<RefRole>,
  mode: string | undefined,
): GenerationInputRoles<T> {
  const entries = connected.filter((entry) => !isGenerationFieldPort(entry.targetInput));
  let firstFrame = frameEntry(entries, "first_frame", mode);
  let lastFrame = frameEntry(entries, "last_frame", mode);
  const loop = frameEntry(entries, "loop", mode);
  const images = imageEntries(entries, mode);
  const frameMode = mode === "i2v" || ((mode === undefined || mode === "default") && Boolean(firstFrame || lastFrame));
  if (frameMode && !firstFrame && modeRoles.has("first_frame") && !modeRoles.has("image")) firstFrame = images.shift();
  if (frameMode && !lastFrame && modeRoles.has("last_frame") && !modeRoles.has("image")) lastFrame = images.shift();
  const candidates: Record<RefRole, T[]> = {
    first_frame: firstFrame ? [firstFrame] : [],
    last_frame: lastFrame ? [lastFrame] : [],
    loop: loop ? [loop] : [],
    keyframe: sortByGenerationInputPort(entries.filter(({ kind, targetInput }) =>
      kind === "image" && generationInputTarget("image", targetInput) === "keyframe"), "keyframe"),
    image: images,
    video: sortByGenerationInputPort(entries.filter(({ kind }) => kind === "video"), "video"),
    audio: sortByGenerationInputPort(entries.filter(({ kind, targetInput }) => kind === "audio" && targetInput !== "replace_audio"), "audio"),
  };
  return Object.fromEntries(REF_ROLES.flatMap((role) =>
    candidates[role].length > 0 && modeRoles.has(role) ? [[role, candidates[role]]] : [])) as GenerationInputRoles<T>;
}

export type GenerationInputKind = "image" | "video" | "audio";

const FRAME_TARGETS = new Set(["first_frame", "last_frame", "loop"]);
const KEYFRAME_TARGET = /^keyframe(?:_\d+)?$/u;
const TOKEN_BODY = "(?<kind>image|video|audio|keyframe)(?<position>\\d+)|firstframe|lastframe|loop";

export function isGenerationFieldPort(targetInput: string): boolean {
  return targetInput.startsWith("slot:");
}

function portSeparator(base: string): string {
  return isGenerationFieldPort(base) ? "#" : "_";
}

export function generationInputTarget(kind: GenerationInputKind, targetInput: string): string {
  if (isGenerationFieldPort(targetInput)) return targetInput.split("#")[0]!;
  if (FRAME_TARGETS.has(targetInput)) return targetInput;
  if (KEYFRAME_TARGET.test(targetInput)) return "keyframe";
  if (kind === "audio" && targetInput === "replace_audio") return targetInput;
  return kind;
}

export function generationModeInputTarget(
  modeId: string | undefined,
  kind: GenerationInputKind,
  target: string,
): string {
  return modeId === "r2v" && kind === "image"
    && (target === "first_frame" || target === "last_frame")
    ? "image"
    : target;
}

function generationInputPortPosition(targetInput: string, base: string): number | null {
  if (targetInput === base) return 1;
  const prefix = `${base}${portSeparator(base)}`;
  if (!targetInput.startsWith(prefix)) return null;
  const suffix = targetInput.slice(prefix.length);
  return /^\d+$/u.test(suffix) ? Number(suffix) : null;
}

export function sortByGenerationInputPort<T extends { targetInput: string }>(
  entries: readonly T[],
  base: string,
): T[] {
  return [...entries].sort((left, right) =>
    (generationInputPortPosition(left.targetInput, base) ?? Number.MAX_SAFE_INTEGER)
    - (generationInputPortPosition(right.targetInput, base) ?? Number.MAX_SAFE_INTEGER));
}

export function generationInputPort(base: string, position: number): string {
  return position === 1 ? base : `${base}${portSeparator(base)}${position}`;
}

export function nextGenerationInputPort(base: string, used: ReadonlySet<string>): string {
  let position = 1;
  while (used.has(generationInputPort(base, position))) position += 1;
  return generationInputPort(base, position);
}

export function sequentialGenerationInputPorts(bases: readonly string[]): string[] {
  const counts = new Map<string, number>();
  return bases.map((base) => {
    const position = (counts.get(base) ?? 0) + 1;
    counts.set(base, position);
    return generationInputPort(base, position);
  });
}

export function generationInputTokenPattern(prefix = ""): RegExp {
  return new RegExp(`${prefix}@(?<token>${TOKEN_BODY})(?![\\w-])`, "giu");
}

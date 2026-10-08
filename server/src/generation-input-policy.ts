type InputKind = "image" | "video" | "audio";

interface ModeInput {
  kind: InputKind;
  target: string;
}

interface InputSlot {
  field: string;
  kind: InputKind;
  targets: string[];
  min: number;
  max: number | null;
}

interface InputMode {
  id: string;
  slots: InputSlot[];
  requiredGroups: string[][];
}

export function generationModeInputTarget(
  modeId: string | undefined,
  kind: InputKind,
  target: string,
): string {
  return modeId === "r2v" && kind === "image"
    && (target === "first_frame" || target === "last_frame")
    ? "image"
    : target;
}

function modeInputs(mode: InputMode, inputs: readonly ModeInput[]): ModeInput[] {
  const normalized = inputs.map((input) => ({
    ...input,
    target: generationModeInputTarget(mode.id, input.kind, input.target),
  }));
  if (mode.id !== "i2v" || mode.slots.some((slot) => slot.targets.includes("image"))) {
    return normalized;
  }
  const available = mode.slots.flatMap((slot) => slot.targets)
    .filter((target) => target === "first_frame" || target === "last_frame")
    .filter((target) => !inputs.some((input) => input.target === target));
  let index = 0;
  return normalized.map((input) => {
    if (input.kind !== "image" || input.target !== "image") return input;
    const target = available[index++];
    return target ? { ...input, target } : input;
  });
}

function inputLabel(target: string): string {
  if (target === "replace_audio") return "replacement audio";
  if (target === "first_frame") return "first frame";
  if (target === "last_frame") return "last frame";
  return `${target} reference`;
}

export function generationModeInputError(
  mode: InputMode,
  inputs: readonly ModeInput[],
): string | null {
  const name = mode.id === "default" || mode.id === "text" ? "this model" : mode.id.toUpperCase();
  const subject = name === "this model" ? "This model" : name;
  const counts = new Map(mode.slots.map((slot) => [slot.field, 0]));
  const sorted = modeInputs(mode, inputs).sort((left, right) =>
    Number(right.target !== right.kind) - Number(left.target !== left.kind));
  for (const input of sorted) {
    const matching = mode.slots.filter((slot) =>
      slot.kind === input.kind && slot.targets.includes(input.target));
    if (matching.length === 0) {
      return `${subject} does not accept ${inputLabel(input.target)} inputs. Change the type or remove that input.`;
    }
    const available = matching.filter((slot) =>
      slot.max === null || (counts.get(slot.field) ?? 0) < slot.max)
      .sort((left, right) => {
        const leftRequired = Number((counts.get(left.field) ?? 0) < left.min);
        const rightRequired = Number((counts.get(right.field) ?? 0) < right.min);
        return rightRequired - leftRequired || left.targets.length - right.targets.length;
      });
    const slot = available[0];
    if (!slot) {
      const maximum = matching.reduce((total, candidate) => total + (candidate.max ?? 0), 0);
      return `${subject} accepts at most ${maximum} ${inputLabel(input.target)} input${maximum === 1 ? "" : "s"}. Remove an input or change the model.`;
    }
    counts.set(slot.field, (counts.get(slot.field) ?? 0) + 1);
  }
  const missing = mode.slots.find((slot) => (counts.get(slot.field) ?? 0) < slot.min);
  if (missing) {
    return `Add at least ${missing.min} ${inputLabel(missing.targets[0] ?? missing.kind)} input${missing.min === 1 ? "" : "s"} for ${name}.`;
  }
  const group = mode.requiredGroups.find((fields) =>
    !fields.some((field) => (counts.get(field) ?? 0) > 0));
  if (!group) return null;
  const labels = [...new Set(mode.slots.filter((slot) => group.includes(slot.field))
    .flatMap((slot) => slot.targets).map(inputLabel))];
  return `Add at least one ${labels.join(" or ")} input for ${name}.`;
}

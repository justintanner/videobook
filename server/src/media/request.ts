import type { ZodError } from "zod";
import type { MediaRefs, ModeSpec, OptionSpec, RefRole, ResolvedModel, SlotField, SlotSpec } from "./types.js";

export interface WireRequestInput {
  prompt?: string;
  refUrls?: MediaRefs;
  options?: Record<string, unknown>;
  mode?: string;
}

export type WireRequestResult =
  | { ok: true; request: Record<string, unknown>; input: Record<string, unknown> }
  | { ok: false; error: string };

type Container = Record<string, unknown> | unknown[];

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function childContainer(current: Container, key: string, nextIsIndex: boolean): Container {
  const holder = current as Record<string, unknown>;
  const existing = holder[key];
  if (existing !== null && typeof existing === "object") return existing as Container;
  const created: Container = nextIsIndex ? [] : {};
  holder[key] = created;
  return created;
}

export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  let current: Container = target;
  segments.slice(0, -1).forEach((segment, index) => {
    current = childContainer(current, segment, /^\d+$/.test(segments[index + 1]!));
  });
  (current as Record<string, unknown>)[segments[segments.length - 1]!] = value;
}

function coerce(option: OptionSpec, value: unknown): unknown {
  if (typeof value !== "string") return value;
  if ((option.valueType === "number" || option.valueType === "integer") && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  if (option.valueType === "boolean" && (value === "true" || value === "false")) return value === "true";
  return value;
}

function refCount(refs: MediaRefs, role: RefRole): number {
  return refs[role]?.length ?? 0;
}

function checkRefs(model: ResolvedModel, refs: MediaRefs, mode: string | undefined): string | null {
  const modeSpec = mode ? model.modes.find((candidate) => candidate.id === mode) : undefined;
  if (mode && !modeSpec) return `${model.id} has no mode ${mode}; modes: ${model.modes.map((m) => m.id).join(", ")}`;
  for (const role of Object.keys(refs) as RefRole[]) {
    const count = refCount(refs, role);
    if (count === 0) continue;
    const slot = model.slots.find((candidate) => candidate.role === role);
    if (!slot) return `${model.id} does not accept ${role} refs`;
    if (modeSpec && !modeSpec.roles.includes(role)) return `${model.id} mode ${modeSpec.id} does not accept ${role} refs`;
    if (slot.max !== null && count > slot.max) return `${model.id} accepts at most ${slot.max} ${role} ref${slot.max === 1 ? "" : "s"}`;
  }
  for (const slot of model.slots) {
    if (modeSpec && !modeSpec.roles.includes(slot.role)) continue;
    if (refCount(refs, slot.role) < slot.min) return `${model.id} requires at least ${slot.min} ${slot.role} ref${slot.min === 1 ? "" : "s"}`;
  }
  const requireAny = modeSpec?.requireAny ?? [];
  if (requireAny.length > 0 && !requireAny.some((role) => refCount(refs, role) > 0)) {
    return `${model.id} mode ${modeSpec!.id} needs one of: ${requireAny.join(", ")}`;
  }
  return null;
}

function refValue(field: SlotField, url: string, item: Record<string, unknown> | undefined): unknown {
  return field.urlObject ? { ...item, url } : url;
}

function placeSlot(model: ResolvedModel, slot: SlotSpec, value: Record<string, unknown>, urls: readonly string[]): void {
  const item = model.entry.refItem?.[slot.role];
  let cursor = 0;
  for (const field of slot.fields) {
    if (cursor >= urls.length) return;
    if (!field.multi) {
      setPath(value, field.path, refValue(field, urls[cursor]!, item));
      cursor += 1;
      continue;
    }
    const take = field.max === null ? urls.length - cursor : Math.min(field.max, urls.length - cursor);
    setPath(value, field.path, urls.slice(cursor, cursor + take).map((url) => refValue(field, url, item)));
    cursor += take;
  }
}

function placeRefs(model: ResolvedModel, value: Record<string, unknown>, refs: MediaRefs): void {
  for (const slot of model.slots) {
    const urls = refs[slot.role] ?? [];
    if (urls.length > 0) placeSlot(model, slot, value, urls);
  }
}

function applyOptions(model: ResolvedModel, value: Record<string, unknown>, options: Record<string, unknown>): string | null {
  for (const [name, raw] of Object.entries(options)) {
    if (raw === undefined) continue;
    const option = model.options.find((candidate) => candidate.name === name);
    if (!option) {
      if (model.slots.some((slot) => slot.fields.some((field) => field.path.split(".")[0] === name))) return `options.${name}: pass media through refs`;
      if (model.promptField?.split(".")[0] === name) return `options.${name}: pass text through prompt`;
      return `options.${name}: not an option of ${model.id}; options: ${model.options.map((o) => o.name).join(", ")}`;
    }
    setPath(value, option.path, coerce(option, raw));
  }
  return null;
}

function activeMode(model: ResolvedModel, refs: MediaRefs, mode: string | undefined): ModeSpec | undefined {
  if (mode) return model.modes.find((candidate) => candidate.id === mode);
  const used = (Object.keys(refs) as RefRole[]).filter((role) => refCount(refs, role) > 0);
  return model.modes.find((candidate) => used.every((role) => candidate.roles.includes(role))
    && ((candidate.requireAny ?? []).length === 0 || (candidate.requireAny ?? []).some((role) => refCount(refs, role) > 0)));
}

function applyModeDefaults(model: ResolvedModel, value: Record<string, unknown>, refs: MediaRefs, mode: string | undefined): void {
  for (const [path, option] of Object.entries(activeMode(model, refs, mode)?.defaults ?? {})) setPath(value, path, clone(option));
}

function hasFrames(refs: MediaRefs): boolean {
  return refCount(refs, "first_frame") > 0 || refCount(refs, "last_frame") > 0;
}

function applyFrameOptions(model: ResolvedModel, value: Record<string, unknown>, refs: MediaRefs, mode: string | undefined): void {
  const frameOptions = model.entry.frameOptions;
  if (!frameOptions || !hasFrames(refs) || mode === "r2v") return;
  for (const [path, option] of Object.entries(frameOptions)) setPath(value, path, option);
}

function checkPrompt(model: ResolvedModel, prompt: string | undefined): string | null {
  const text = prompt?.trim() ?? "";
  if (model.promptField === null) return text === "" ? null : `${model.id} takes no prompt`;
  if (text === "" && model.promptRequired) return `${model.id} requires a prompt`;
  const max = model.entry.rules?.maxPromptChars;
  if (max !== undefined && text.length > max) return `${model.id} prompt is ${text.length} characters; the limit is ${max}`;
  return null;
}

function issueLabel(path: readonly PropertyKey[]): string {
  return path
    .filter((segment) => segment !== "input")
    .map(String)
    .join(" ")
    .replaceAll("_", " ")
    .replace(/^./u, (character) => character.toUpperCase());
}

function issueMessage(issue: ZodError["issues"][number]): string {
  const input = "input" in issue ? issue.input : undefined;
  const missing = issue.code === "invalid_type" && (input === undefined || input === null);
  return missing ? "Required" : issue.message;
}

function formatIssues(model: ResolvedModel, error: ZodError): string {
  const issues = error.issues.map((issue) => {
    const label = issueLabel(issue.path);
    return label ? `${label}: ${issueMessage(issue)}` : `${model.title}: ${issueMessage(issue)}`;
  });
  return issues.join("; ");
}

export function buildWireRequest(model: ResolvedModel, call: WireRequestInput): WireRequestResult {
  const refs = call.refUrls ?? {};
  const refError = checkRefs(model, refs, call.mode);
  if (refError) return { ok: false, error: refError };
  const promptError = checkPrompt(model, call.prompt);
  if (promptError) return { ok: false, error: promptError };
  const value: Record<string, unknown> = clone(model.entry.defaults) ?? {};
  applyModeDefaults(model, value, refs, call.mode);
  placeRefs(model, value, refs);
  const optionError = applyOptions(model, value, call.options ?? {});
  if (optionError) return { ok: false, error: optionError };
  applyFrameOptions(model, value, refs, call.mode);
  const prompt = call.prompt?.trim();
  if (model.promptField && prompt) setPath(value, model.promptField, prompt);
  const input = model.wire.input.safeParse(value);
  if (!input.success) return { ok: false, error: formatIssues(model, input.error) };
  const parsed = model.wire.request.safeParse(model.wire.wrap(input.data as Record<string, unknown>));
  if (!parsed.success) return { ok: false, error: formatIssues(model, parsed.error) };
  return { ok: true, request: parsed.data as Record<string, unknown>, input: input.data as Record<string, unknown> };
}

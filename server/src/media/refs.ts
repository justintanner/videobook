import { isSeedanceEdit } from "./seedance-edit.js";
import type { Engine } from "videobook-engine";
import { join } from "node:path";
import { probeVideo } from "../ffmpeg.js";
import { referenceVideoDuration } from "../reference-video-duration.js";
import { insertVideoTimingError, isInsertVideoModel } from "./insert-video-timing.js";
import { isH3ReframeModel, reframeVideoGeometryError } from "./reframe-video.js";
import { resolveAudioRef, resolveImageRef, resolveVideoRef, type RefInput } from "../tools/_media-refs.js";
import type { ProviderAdapter } from "./adapters/types.js";
import type { UploadLimits } from "../upload.js";
import type { RefParams } from "./request.js";
import { REF_ROLES, type FieldRefs, type MediaRefs, type RefDurationWindowMs, type RefRole, type ResolvedModel } from "./types.js";

export interface ResolvedRefs {
  urls: MediaRefs;
  sourceImageIds: string[];
  sourceVideoIds: string[];
  sourceAudioIds: string[];
}

type Kind = "image" | "video" | "audio";

function kindOf(role: RefRole): Kind {
  if (role === "video") return "video";
  if (role === "audio") return "audio";
  return "image";
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

export async function resolveRefInput(engine: Engine, kind: Kind, raw: string): Promise<RefInput> {
  const resolved = kind === "video"
    ? await resolveVideoRef(engine, raw)
    : kind === "audio"
      ? await resolveAudioRef(engine, raw)
      : await resolveImageRef(engine, raw);
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.value;
}

function sourceList(result: ResolvedRefs, kind: Kind): string[] {
  if (kind === "video") return result.sourceVideoIds;
  if (kind === "audio") return result.sourceAudioIds;
  return result.sourceImageIds;
}

function uploadLimits(model: ResolvedModel, kind: Kind): UploadLimits | undefined {
  const maxVideoBytes = kind === "video" ? model.entry.rules?.maxVideoRefBytes : undefined;
  return maxVideoBytes === undefined ? undefined : { maxVideoBytes };
}

async function uploadRef(
  engine: Engine,
  adapter: ProviderAdapter,
  model: ResolvedModel,
  kind: Kind,
  raw: string,
  result: ResolvedRefs,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (isHttpUrl(raw)) return adapter.uploadUrl(raw);
  const input = await resolveRefInput(engine, kind, raw);
  sourceList(result, kind).push(input.assetId);
  return adapter.upload(engine, input.assetId, input.filename, signal, uploadLimits(model, kind));
}

export async function uploadRefs(engine: Engine, adapter: ProviderAdapter, model: ResolvedModel, refs: MediaRefs, signal?: AbortSignal): Promise<ResolvedRefs> {
  const result: ResolvedRefs = { urls: {}, sourceImageIds: [], sourceVideoIds: [], sourceAudioIds: [] };
  for (const role of REF_ROLES) {
    const raws = refs[role] ?? [];
    if (raws.length === 0) continue;
    const urls: string[] = [];
    for (const raw of raws) urls.push(await uploadRef(engine, adapter, model, kindOf(role), raw, result, signal));
    result.urls[role] = urls;
  }
  return result;
}

export async function uploadFieldRefs(
  engine: Engine,
  adapter: ProviderAdapter,
  model: ResolvedModel,
  fieldRefs: FieldRefs,
  result: ResolvedRefs,
  signal?: AbortSignal,
): Promise<FieldRefs> {
  const urls: FieldRefs = {};
  for (const slot of model.fieldSlots) {
    const raws = fieldRefs[slot.field] ?? [];
    const uploaded: string[] = [];
    for (const raw of raws) uploaded.push(await uploadRef(engine, adapter, model, slot.kind, raw, result, signal));
    if (uploaded.length > 0) urls[slot.field] = uploaded;
  }
  return urls;
}

export async function checkFieldRefs(engine: Engine, model: ResolvedModel, fieldRefs: FieldRefs): Promise<string | null> {
  for (const [field, raws] of Object.entries(fieldRefs)) {
    const slot = model.fieldSlots.find((candidate) => candidate.field === field);
    if (!slot) return `${model.id} has no ${field} input`;
    for (const raw of raws ?? []) {
      if (isHttpUrl(raw)) continue;
      try {
        await resolveRefInput(engine, slot.kind, raw);
      } catch (error) {
        return `${field} ref ${raw}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  return null;
}

export function normalizeFieldRefs(raw: unknown): FieldRefs {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).flatMap(([field, value]) => {
    const list = Array.isArray(value) ? value : [value];
    const strings = list.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
    return strings.length > 0 ? [[field, strings]] : [];
  }));
}

export async function checkRefs(engine: Engine, refs: MediaRefs): Promise<string | null> {
  for (const role of REF_ROLES) {
    for (const raw of refs[role] ?? []) {
      if (isHttpUrl(raw)) continue;
      try {
        await resolveRefInput(engine, kindOf(role), raw);
      } catch (error) {
        return `${role} ref ${raw}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  return null;
}

export function normalizeRefs(raw: unknown): MediaRefs {
  if (raw === null || typeof raw !== "object") return {};
  const refs: MediaRefs = {};
  for (const role of REF_ROLES) {
    const value = (raw as Record<string, unknown>)[role];
    const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
    const strings = list.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
    if (strings.length > 0) refs[role] = strings;
  }
  return refs;
}

function itemParamValues(raw: unknown): Record<string, number> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const values = Object.entries(raw as Record<string, unknown>)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]));
  return values.length > 0 ? Object.fromEntries(values) : null;
}

export function normalizeRefParams(raw: unknown): RefParams {
  if (raw === null || typeof raw !== "object") return {};
  const params: Partial<Record<RefRole, Array<Record<string, number> | null>>> = {};
  for (const role of REF_ROLES) {
    const value = (raw as Record<string, unknown>)[role];
    if (!Array.isArray(value)) continue;
    const list = value.map(itemParamValues);
    if (list.some((entry) => entry !== null)) params[role] = list;
  }
  return params;
}

type TimedRole = "video" | "audio";

function seconds(ms: number): string {
  return String(Math.round(ms / 100) / 10);
}

async function knownDurationMs(engine: Engine, role: TimedRole, raw: string): Promise<number | undefined> {
  if (isHttpUrl(raw)) return undefined;
  const input = await resolveRefInput(engine, role, raw);
  if (!input.filename.startsWith("original")) return undefined;
  const meta = await engine.metadata.artifacts.read<{ duration?: unknown }>(input.assetId, "original");
  const duration = meta.ok ? meta.value?.duration : undefined;
  return typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : undefined;
}

function clipError(modelId: string, role: TimedRole, raw: string, ms: number, window: RefDurationWindowMs): string | null {
  if (ms >= window.minimum && ms <= window.maximum) return null;
  return `${role} ref ${raw} is ${seconds(ms)} s; ${modelId} accepts ${seconds(window.minimum)}-${seconds(window.maximum)} s per ${role} reference`;
}

async function checkRoleDurations(engine: Engine, modelId: string, role: TimedRole, raws: readonly string[], window: RefDurationWindowMs): Promise<string | null> {
  let total = 0;
  for (const raw of raws) {
    const ms = await knownDurationMs(engine, role, raw);
    if (ms === undefined) continue;
    const error = clipError(modelId, role, raw, ms, window);
    if (error) return error;
    total += ms;
  }
  return total > window.maximumTotal
    ? `${role} refs total ${seconds(total)} s; ${modelId} accepts at most ${seconds(window.maximumTotal)} s of ${role} references`
    : null;
}

export async function checkRefDurations(engine: Engine, model: ResolvedModel, refs: MediaRefs): Promise<string | null> {
  const windows = model.entry.rules?.refDurationMs;
  if (!windows) return null;
  for (const role of ["video", "audio"] as const) {
    const window = windows[role];
    const error = window ? await checkRoleDurations(engine, model.id, role, refs[role] ?? [], window) : null;
    if (error) return error;
  }
  return null;
}

export async function checkInsertVideoTiming(engine: Engine, model: ResolvedModel, refs: MediaRefs, options: Record<string, unknown>): Promise<string | null> {
  if (!isInsertVideoModel(model.id)) return null;
  const source = refs.video?.[0];
  const duration = source ? await referenceVideoDuration(engine, [source]) : undefined;
  return insertVideoTimingError(options, duration);
}

export async function checkReframeVideoGeometry(engine: Engine, model: ResolvedModel, refs: MediaRefs, options: Record<string, unknown>): Promise<string | null> {
  if (!isH3ReframeModel(model.id)) return null;
  const source = refs.video?.[0];
  if (!source || isHttpUrl(source)) return null;
  const input = await resolveRefInput(engine, "video", source);
  const settings = { ...model.entry.defaults, ...options };
  if (/^original\.[^.]+$/u.test(input.filename)) {
    const meta = await engine.metadata.artifacts.read<{ width?: unknown; height?: unknown }>(input.assetId, "original");
    const { width, height } = meta.ok ? meta.value : {};
    if (typeof width === "number" && Number.isFinite(width) && width > 0 && typeof height === "number" && Number.isFinite(height) && height > 0) {
      return reframeVideoGeometryError(settings, width, height);
    }
  }
  const manifest = await engine.files.manifest(input.assetId);
  if (!manifest.ok) return manifest.error.message;
  const { width, height } = await probeVideo(join(manifest.value.path, input.filename));
  return reframeVideoGeometryError(settings, width, height);
}

export async function checkSeedanceEditSource(engine: Engine, model: ResolvedModel, refs: MediaRefs, mode: unknown): Promise<string | null> {
  if (!isSeedanceEdit(model.id, mode)) return null;
  if (refs.video?.length !== 1) return "Seedance Edit video requires exactly one source video (4–30 seconds).";
  const duration = await referenceVideoDuration(engine, refs.video);
  if (duration === undefined) return "Seedance Edit video requires a source with known duration. Import the video into the book and use its artifact reference (4–30 seconds).";
  return duration < 4 || duration > 30
    ? `Seedance Edit video source is ${duration} seconds; use a source between 4 and 30 seconds.`
    : null;
}

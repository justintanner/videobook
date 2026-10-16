import type { Engine } from "videobook-engine";
import { resolveAudioRef, resolveImageRef, resolveVideoRef, type RefInput } from "../tools/_seedance2-shared.js";
import type { ProviderAdapter } from "./adapters/types.js";
import { REF_ROLES, type MediaRefs, type RefRole } from "./types.js";

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

export function isHttpUrl(value: string): boolean {
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

async function uploadRef(
  engine: Engine,
  adapter: ProviderAdapter,
  kind: Kind,
  raw: string,
  result: ResolvedRefs,
): Promise<string> {
  if (isHttpUrl(raw)) return adapter.uploadUrl(raw);
  const input = await resolveRefInput(engine, kind, raw);
  sourceList(result, kind).push(input.assetId);
  return adapter.upload(engine, input.assetId, input.filename);
}

export async function uploadRefs(engine: Engine, adapter: ProviderAdapter, refs: MediaRefs): Promise<ResolvedRefs> {
  const result: ResolvedRefs = { urls: {}, sourceImageIds: [], sourceVideoIds: [], sourceAudioIds: [] };
  for (const role of REF_ROLES) {
    const raws = refs[role] ?? [];
    if (raws.length === 0) continue;
    const urls: string[] = [];
    for (const raw of raws) urls.push(await uploadRef(engine, adapter, kindOf(role), raw, result));
    result.urls[role] = urls;
  }
  return result;
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

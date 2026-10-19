import { isPreviewPlaceholderUrl, previewPlaceholderUrl } from "../preview-payload.js";
import { resolveModel, UnknownModelError } from "./descriptor.js";
import { applyPromptDialect } from "./prompt-dialects.js";
import { buildWireRequest } from "./request.js";
import { normalizeRefs } from "./refs.js";
import { isKieSunoModel, isKieVeoModel } from "./wire.js";
import { REF_ROLES, type MediaRefs, type ResolvedModel } from "./types.js";

export interface PreviewPlaceholder {
  path: string;
  reference: string;
  url: string;
}

export interface GenerationPreview {
  model: ResolvedModel;
  providerPath: string;
  payload: Record<string, unknown>;
  placeholders: PreviewPlaceholder[];
}

const ELEVENLABS_PATHS: Record<string, string> = {
  "text-to-speech": "elevenlabs.v1.textToSpeech(voice_id, request)",
  "sound-generation": "elevenlabs.v1.soundGeneration(request)",
  music: "elevenlabs.v1.music(request)",
  "video-to-music": "elevenlabs.v1.music.videoToMusic(request)",
};

function providerPath(model: ResolvedModel): string {
  switch (model.provider) {
    case "kie":
      if (isKieVeoModel(model.apiId)) return "kie.veo.post.api.v1.veo.generate(request, { otp })";
      if (isKieSunoModel(model.apiId)) return "kie.suno.post.api.v1.generate(request)";
      return "kie.post.api.v1.jobs.createTask(request, { otp })";
    case "fal":
      return "fal.post.v1.queue.submit()";
    case "xai":
      return "xai.post.v1.videos.generations(request, { otp })";
    case "alibaba":
      return "alibaba.post.api.v1.services.aigc.multimodalGeneration.generation(request)";
    case "elevenlabs":
      return ELEVENLABS_PATHS[model.apiId] ?? "elevenlabs";
  }
}

function placeholderRefs(refs: MediaRefs): MediaRefs {
  const placeholders: MediaRefs = {};
  for (const role of REF_ROLES) {
    const list = refs[role];
    if (list) placeholders[role] = list.map((ref) => /^https?:\/\//u.test(ref) ? ref : previewPlaceholderUrl(ref));
  }
  return placeholders;
}

function collectPlaceholders(value: unknown, path: string, found: PreviewPlaceholder[]): void {
  if (typeof value === "string") {
    if (isPreviewPlaceholderUrl(value)) {
      const reference = decodeURIComponent(new URL(value).pathname.slice(1));
      found.push({ path, reference: `@${reference}`, url: value });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectPlaceholders(item, `${path}[${index}]`, found));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) collectPlaceholders(child, path ? `${path}.${key}` : key, found);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionsOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function previewGeneration(args: Record<string, unknown>): { ok: true; preview: GenerationPreview } | { ok: false; error: string } {
  let model: ResolvedModel;
  try {
    model = resolveModel(String(args.model ?? ""));
  } catch (error) {
    return { ok: false, error: error instanceof UnknownModelError ? error.message : String(error) };
  }
  const refs = normalizeRefs(args.refs);
  const rawPrompt = stringOrUndefined(args.prompt);
  const built = buildWireRequest(model, {
    prompt: rawPrompt === undefined ? undefined : applyPromptDialect(model.entry.dialect, rawPrompt, refs),
    refUrls: placeholderRefs(refs),
    options: optionsOf(args.options),
    mode: stringOrUndefined(args.mode),
  });
  if (!built.ok) return built;
  const payload = model.provider === "fal" ? { endpoint_id: model.apiId, input: built.request } : built.request;
  const placeholders: PreviewPlaceholder[] = [];
  collectPlaceholders(payload, "", placeholders);
  return { ok: true, preview: { model, providerPath: providerPath(model), payload, placeholders } };
}

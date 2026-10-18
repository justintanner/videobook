import { LIGHTNING_SCENE_MODEL, LIGHTNING_VIDEO_MODEL } from "./lightning-defaults.js";
import { listElevenLabsVoices } from "./tools/list-elevenlabs-voices.js";
import { isChainRef } from "./chain-plan.js";

export const CHAT_DEFAULT_MODELS: Readonly<Record<string, string>> = {
  generate_image: LIGHTNING_SCENE_MODEL,
  generate_video: LIGHTNING_VIDEO_MODEL,
  generate_audio: "elevenlabs:text-to-speech",
};

const FLAT_REF_FIELDS: Readonly<Record<string, string>> = {
  image_refs: "image",
  image_ref: "image",
  video_refs: "video",
  video_ref: "video",
  audio_refs: "audio",
  audio_ref: "audio",
  first_frame_ref: "first_frame",
  last_frame_ref: "last_frame",
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function list(value: unknown): unknown[] {
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return values.filter((entry) => (typeof entry === "string" && entry.trim() !== "") || isChainRef(entry));
}

function foldFlatRefs(params: Record<string, unknown>): Record<string, unknown> {
  const refs: Record<string, unknown[]> = Object.fromEntries(
    Object.entries(record(params.refs)).map(([role, value]) => [role, list(value)]),
  );
  const next: Record<string, unknown> = { ...params };
  for (const [field, role] of Object.entries(FLAT_REF_FIELDS)) {
    if (!(field in next)) continue;
    refs[role] = [...(refs[role] ?? []), ...list(next[field])];
    delete next[field];
  }
  const kept = Object.fromEntries(Object.entries(refs).filter(([, values]) => values.length > 0));
  return Object.keys(kept).length > 0 ? { ...next, refs: kept } : next;
}

async function withDefaultVoice(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (params.model !== "elevenlabs:text-to-speech") return params;
  const options = record(params.options);
  if (typeof options.voice_id === "string" && options.voice_id.trim() !== "") return params;
  const fallback = (await listElevenLabsVoices()).voices[0]?.voice_id;
  return fallback ? { ...params, options: { ...options, voice_id: fallback } } : params;
}

/**
 * Fill routing gaps for chat-dispatched generations: the router may omit the
 * model, keep provider-era ref fields at the top level, or leave the ElevenLabs
 * voice unset because it cannot know voice ids. The review sheet shows the
 * filled values before anything runs.
 */
export async function applyGenerationRoutingDefaults(
  tool: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (tool === "chain" && Array.isArray(params.steps)) {
    const steps = await Promise.all(params.steps.map(async (entry: unknown) => {
      const step = record(entry);
      if (typeof step.tool !== "string" || !CHAT_DEFAULT_MODELS[step.tool]) return entry;
      if (!step.params || typeof step.params !== "object" || Array.isArray(step.params)) return entry;
      return { ...step, params: await applyGenerationRoutingDefaults(step.tool, record(step.params)) };
    }));
    return { ...params, steps };
  }
  const defaultModel = CHAT_DEFAULT_MODELS[tool];
  if (!defaultModel) return params;
  const folded = foldFlatRefs(params);
  const withModel = typeof folded.model === "string" && folded.model.trim() !== ""
    ? folded
    : { ...folded, model: defaultModel };
  return withDefaultVoice(withModel);
}

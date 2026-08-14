import { createElevenLabs, type ElevenLabsListVoicesResponse, type ElevenLabsVoice } from "@apicity/elevenlabs";
import type { ToolDef } from "./tool-def.js";
import { getApiKey } from "../api-key.js";

export type ElevenLabsVoiceSource = "custom" | "generic";

export interface ElevenLabsVoiceOption {
  voice_id: string;
  name: string;
  source: ElevenLabsVoiceSource;
  category?: string;
  preview_url?: string;
}

interface ElevenLabsVoiceListResponse {
  voices: ElevenLabsVoiceOption[];
  status: "live" | "fallback";
  warning: string | null;
}

type VoiceFetch = typeof fetch;

const GENERIC_FALLBACK_VOICES: ElevenLabsVoiceOption[] = [
  { voice_id: "JBFqnCBsd6RMkjVDRZzb", name: "Generic", source: "generic" },
  { voice_id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", source: "generic" },
  { voice_id: "AZnzlk1XvdvUeBnXmlld", name: "Domi", source: "generic" },
  { voice_id: "EXAVITQu4vr4xnSDxMaL", name: "Bella", source: "generic" },
  { voice_id: "ErXwobaYiN019PkySvjV", name: "Antoni", source: "generic" },
  { voice_id: "MF3mGyEYCl7XYWbV9V6O", name: "Elli", source: "generic" },
  { voice_id: "TxGEqnHWrfWFTfGW9XjX", name: "Josh", source: "generic" },
  { voice_id: "VR6AewLTigWG4xSOukaG", name: "Arnold", source: "generic" },
  { voice_id: "pNInz6obpgDQGcFmaJgB", name: "Adam", source: "generic" },
  { voice_id: "yoZ06aMxZJJ28mfd3POQ", name: "Sam", source: "generic" },
];

function readConfiguredCustomVoices(): ElevenLabsVoiceOption[] {
  const raw = process.env.ELEVENLABS_CUSTOM_VOICE_IDS ?? process.env.ELEVENLABS_CUSTOM_VOICES ?? "";
  return raw
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseCustomVoice)
    .filter((voice): voice is ElevenLabsVoiceOption => voice !== null);
}

function parseCustomVoice(entry: string): ElevenLabsVoiceOption | null {
  const parts = entry.split(/\s*(?:=|\||:)\s*/);
  if (parts.length >= 2) {
    const [name, ...idParts] = parts;
    const voiceId = idParts.join(":").trim();
    if (!voiceId) return null;
    return { voice_id: voiceId, name: name.trim() || voiceId, source: "custom" };
  }
  return { voice_id: entry, name: entry, source: "custom" };
}

function addUnique(target: ElevenLabsVoiceOption[], seen: Set<string>, voice: ElevenLabsVoiceOption): void {
  const id = voice.voice_id.trim();
  if (!id || seen.has(id)) return;
  seen.add(id);
  target.push({ ...voice, voice_id: id, name: voice.name.trim() || id });
}

function mergeVoiceGroups(...groups: ElevenLabsVoiceOption[][]): ElevenLabsVoiceOption[] {
  const seen = new Set<string>();
  const voices: ElevenLabsVoiceOption[] = [];
  for (const group of groups) {
    for (const voice of group) {
      addUnique(voices, seen, voice);
    }
  }
  return voices;
}

function normalizeApiVoice(item: ElevenLabsVoice, source: ElevenLabsVoiceSource): ElevenLabsVoiceOption | null {
  const voiceId = item.voice_id.trim();
  if (!voiceId) return null;
  const name = item.name?.trim() || voiceId;
  const category = item.category?.trim();
  const previewUrl = item.preview_url?.trim();
  return {
    voice_id: voiceId,
    name,
    source,
    ...(category ? { category } : {}),
    ...(previewUrl ? { preview_url: previewUrl } : {}),
  };
}

async function fetchVoiceGroup(apiKey: string, voiceType: "non-default" | "default", fetchFn: VoiceFetch): Promise<ElevenLabsVoiceOption[]> {
  const provider = createElevenLabs({ apiKey, timeout: 30_000, fetch: fetchFn });
  const source: ElevenLabsVoiceSource = voiceType === "default" ? "generic" : "custom";
  const voices: ElevenLabsVoiceOption[] = [];
  let nextPageToken: string | null = null;

  for (let page = 0; page < 10; page += 1) {
    const body: ElevenLabsListVoicesResponse = await provider.v2.voices({
      voice_type: voiceType,
      page_size: 100,
      include_total_count: false,
      ...(nextPageToken ? { next_page_token: nextPageToken } : {}),
    });
    for (const item of body.voices) {
      const normalized = normalizeApiVoice(item, source);
      if (normalized) voices.push(normalized);
    }

    nextPageToken = body.next_page_token?.trim()
      ? body.next_page_token.trim()
      : null;
    if (!body.has_more || !nextPageToken) break;
  }

  return voices;
}

export async function listElevenLabsVoices(fetchFn: VoiceFetch = fetch): Promise<ElevenLabsVoiceListResponse> {
  const configuredCustom = readConfiguredCustomVoices();
  const apiKey = getApiKey("ELEVENLABS_API_KEY");
  if (!apiKey) {
    return {
      voices: mergeVoiceGroups(configuredCustom, GENERIC_FALLBACK_VOICES),
      status: "fallback",
      warning: "ELEVENLABS_API_KEY is not configured; showing configured custom IDs and generic fallback IDs.",
    };
  }

  try {
    const [custom, generic] = await Promise.all([
      fetchVoiceGroup(apiKey, "non-default", fetchFn),
      fetchVoiceGroup(apiKey, "default", fetchFn),
    ]);
    return {
      voices: mergeVoiceGroups(configuredCustom, custom, generic.length > 0 ? generic : GENERIC_FALLBACK_VOICES),
      status: "live",
      warning: generic.length > 0 ? null : "No default voices were returned by ElevenLabs; generic fallback IDs are shown after custom voices.",
    };
  } catch (error) {
    return {
      voices: mergeVoiceGroups(configuredCustom, GENERIC_FALLBACK_VOICES),
      status: "fallback",
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}

const LIVE_VOICE_CACHE_TTL_MS = 5 * 60 * 1000;

let liveVoiceCache: {
  expiresAt: number;
  payload: ElevenLabsVoiceListResponse;
} | null = null;

export function listElevenLabsVoicesDef(): ToolDef {
  return {
    name: "list_elevenlabs_voices",
    description: "List available ElevenLabs voice IDs with custom voices first and generic voices after them",
    schema: {},
    handler: async () => {
      const now = Date.now();
      if (liveVoiceCache && liveVoiceCache.expiresAt > now) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(liveVoiceCache.payload),
          }],
        };
      }
      const payload = await listElevenLabsVoices();
      if (payload.status === "live") {
        liveVoiceCache = {
          expiresAt: now + LIVE_VOICE_CACHE_TTL_MS,
          payload,
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      };
    },
  };
}

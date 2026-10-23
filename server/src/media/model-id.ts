import type { ParsedModelId, ProviderId } from "./types.js";

const PROVIDERS: readonly ProviderId[] = ["kie", "fal", "xai", "alibaba", "elevenlabs", "machgen"];

function isProvider(value: string): value is ProviderId {
  return (PROVIDERS as readonly string[]).includes(value);
}

export function parseModelId(raw: string): ParsedModelId | null {
  const index = raw.indexOf(":");
  if (index <= 0) return null;
  const provider = raw.slice(0, index);
  const apiId = raw.slice(index + 1);
  if (!isProvider(provider) || apiId.trim() === "") return null;
  return { id: raw, provider, apiId };
}

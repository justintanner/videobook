import type { Engine } from "videobook-engine";

const PROVIDER_MEMORY_KEY = "generation-provider-memory";
const familyIdPattern = /^[a-z][a-z0-9:._-]{0,180}$/;
const providerIdPattern = /^[a-z][a-z0-9-]{0,40}$/;

function providerMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const map: Record<string, string> = {};
  for (const [familyId, provider] of Object.entries(value)) {
    if (typeof provider !== "string") continue;
    const family = familyId.trim();
    const chosen = provider.trim();
    if (!familyIdPattern.test(family) || !providerIdPattern.test(chosen)) continue;
    map[family] = chosen;
  }
  return map;
}

export function readGenerationProviderMemory(engine: Engine): Record<string, string> {
  return providerMap(engine.settings.get(PROVIDER_MEMORY_KEY));
}

export function rememberGenerationProvider(
  engine: Engine,
  familyId: string,
  provider: string,
): Record<string, string> {
  const family = familyId.trim();
  const chosen = provider.trim();
  if (!familyIdPattern.test(family)) throw new Error("Unknown model family");
  if (!providerIdPattern.test(chosen)) throw new Error("Unknown provider");
  const current = readGenerationProviderMemory(engine);
  if (current[family] === chosen) return current;
  const next = { ...current, [family]: chosen };
  const written = engine.settings.set(PROVIDER_MEMORY_KEY, next);
  if (!written.ok) throw new Error(written.error.message);
  return next;
}

import type { Engine } from "videobook-engine";

const SETTINGS_KEY = "image-edit-model-selection";

export function readLastImageEditModel(engine: Engine): string | null {
  const stored = engine.settings.get<Record<string, unknown>>(SETTINGS_KEY);
  const modelId = stored?.modelId;
  return typeof modelId === "string" && modelId.trim() ? modelId.trim() : null;
}

export function writeLastImageEditModel(engine: Engine, modelId: string): void {
  const written = engine.settings.set(SETTINGS_KEY, { modelId });
  if (!written.ok) throw new Error(written.error.message);
}

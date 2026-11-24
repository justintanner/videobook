import type { Engine } from "videobook-engine";
import { GraphicsServiceError } from "./errors.js";
import type { GraphicsLogo, GraphicsLogoInput } from "./logo.js";
import { graphicsLogoFrom } from "./logo.js";
import type { GraphicsPosition } from "./model.js";

const LOGO_KEY = "graphics.logo.v1";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function isBookImage(engine: Engine, artifactId: string): boolean {
  const artifact = engine.artifacts.get(artifactId);
  return artifact.ok && artifact.value.kind === "image";
}

export function readGraphicsLogo(engine: Engine): GraphicsLogo | null {
  const stored = record(engine.settings.get<unknown>(LOGO_KEY));
  if (!stored || typeof stored.artifactId !== "string") return null;
  const position = record(stored.position) as Partial<GraphicsPosition> | null;
  const parsed = graphicsLogoFrom({
    artifactId: stored.artifactId,
    ...(position ? { position } : {}),
    ...(finite(stored.size) === undefined ? {} : { size: finite(stored.size) }),
    ...(finite(stored.opacity) === undefined ? {} : { opacity: finite(stored.opacity) }),
  });
  return parsed.ok ? parsed.logo : null;
}

function clearGraphicsLogo(engine: Engine): void {
  const deleted = engine.settings.delete(LOGO_KEY);
  if (!deleted.ok) throw new Error(deleted.error.message);
}

export function setGraphicsLogo(engine: Engine, input: GraphicsLogoInput | null): GraphicsLogo | null {
  if (input === null) {
    clearGraphicsLogo(engine);
    return null;
  }
  if (!isBookImage(engine, input.artifactId)) {
    throw new GraphicsServiceError("invalid", `${input.artifactId} is not an image in this book. Choose an image cell for the logo.`);
  }
  const parsed = graphicsLogoFrom(input);
  if (!parsed.ok) throw new GraphicsServiceError("invalid", `Logo ${parsed.error}`);
  const written = engine.settings.set(LOGO_KEY, parsed.logo);
  if (!written.ok) throw new Error(written.error.message);
  return parsed.logo;
}

export function forgetGraphicsLogo(engine: Engine, artifactId: string): void {
  if (readGraphicsLogo(engine)?.artifactId === artifactId) clearGraphicsLogo(engine);
}

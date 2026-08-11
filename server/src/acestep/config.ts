import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isHealthy } from "./client.js";

export interface AceStepConfig {
  baseUrl: string | null;
  serverPath: string;
  modelsDir: string;
  port: number;
  model: string;
  keepLoaded: boolean;
}

export type AceStepAvailability =
  | { available: true }
  | { available: false; kind: "binary_missing" | "models_missing" | "unreachable"; reason: string };

const DEFAULT_PORT = 8317;
const DEFAULT_MODEL = "acestep-v15-turbo-Q4_K_M.gguf";
const TEXT_ENCODER_MODEL = "Qwen3-Embedding-0.6B-Q8_0.gguf";
const VAE_MODEL = "vae-BF16.gguf";
const GATE_HEALTH_TIMEOUT_MS = 500;

function acestepRoot(): string {
  return join(homedir(), ".cache", "videobook", "acestep");
}

export function aceStepConfig(): AceStepConfig {
  const baseUrl = process.env.VIDEOBOOK_ACESTEP_BASE_URL?.trim();
  const parsedPort = Number.parseInt(process.env.VIDEOBOOK_ACESTEP_PORT ?? "", 10);
  return {
    baseUrl: baseUrl ? baseUrl.replace(/\/+$/u, "") : null,
    serverPath:
      process.env.VIDEOBOOK_ACESTEP_SERVER_PATH?.trim() || join(acestepRoot(), "bin", "ace-server"),
    modelsDir: process.env.VIDEOBOOK_ACESTEP_MODELS_DIR?.trim() || join(acestepRoot(), "models"),
    port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT,
    model: process.env.VIDEOBOOK_ACESTEP_MODEL?.trim() || DEFAULT_MODEL,
    keepLoaded: process.env.VIDEOBOOK_ACESTEP_KEEP_LOADED === "1",
  };
}

export function requiredModelFiles(config: AceStepConfig = aceStepConfig()): string[] {
  return [config.model, TEXT_ENCODER_MODEL, VAE_MODEL];
}

export function checkLocalAvailability(config: AceStepConfig = aceStepConfig()): AceStepAvailability {
  if (!existsSync(config.serverPath)) {
    return {
      available: false,
      kind: "binary_missing",
      reason:
        `acestep.cpp runtime is not installed: ace-server not found at ${config.serverPath}. ` +
        `Run "npm run install:acestep", or set VIDEOBOOK_ACESTEP_SERVER_PATH / VIDEOBOOK_ACESTEP_BASE_URL.`,
    };
  }
  const missing = requiredModelFiles(config).filter(
    (name) => !existsSync(join(config.modelsDir, name)),
  );
  if (missing.length > 0) {
    return {
      available: false,
      kind: "models_missing",
      reason: `ACE-Step models missing from ${config.modelsDir}: ${missing.join(", ")}. Run "npm run install:acestep".`,
    };
  }
  return { available: true };
}

export async function checkAceStepAvailability(): Promise<AceStepAvailability> {
  const config = aceStepConfig();
  if (config.baseUrl !== null) {
    const healthy = await isHealthy(config.baseUrl, GATE_HEALTH_TIMEOUT_MS);
    if (!healthy) {
      return {
        available: false,
        kind: "unreachable",
        reason:
          `ace-server at ${config.baseUrl} did not answer /health within ${GATE_HEALTH_TIMEOUT_MS}ms ` +
          `(VIDEOBOOK_ACESTEP_BASE_URL). Start it or unset the variable.`,
      };
    }
    return { available: true };
  }
  return checkLocalAvailability(config);
}

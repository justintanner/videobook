/**
 * Secret-source detection and .env editing.
 *
 * Secrets reach the server two ways:
 *   1. `op run --env-file=.env.tpl --` resolves op:// references and injects
 *      them into the environment BEFORE Node starts (npm run dev:server).
 *   2. A plain `.env` file, loaded here with dotenv semantics: never override
 *      a var that is already set, so op-injected values always win.
 *
 * A managed key that was already set before `.env` loaded is therefore
 * "1password" — externally managed and read-only, because a `.env` write
 * would be silently shadowed on the next start. A key whose value arrived
 * via `.env` is "env" and editable. A shell-exported var is also classified
 * "1password"; the label is approximate but the read-only behavior is right.
 *
 * `.env` lives at the repo root and is server runtime configuration, not a
 * project artifact, so direct node:fs is correct here — the videobook-engine
 * rule covers managed artifacts and their materialized workspaces.
 */
import { readFileSync } from "node:fs";
import { readFile, writeFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { parse } from "dotenv";

export const MANAGED_ENV_KEYS = [
  "OPENAI_API_KEY",
  "KIE_API_KEY",
  "XAI_API_KEY",
  "X_CLIENT_ID",
  "X_CLIENT_SECRET",
  "KIMI_CODING_API_KEY",
  "FAL_API_KEY",
  "DASHSCOPE_API_KEY",
  "GOOGLE_FLOW_API_KEY",
  "ELEVENLABS_API_KEY",
  "B2_ACCESS_KEY_ID",
  "B2_SECRET_ACCESS_KEY",
  "B2_REGION",
  "B2_BUCKET",
  "B2_ENDPOINT",
  "B2_ARCHIVE_PREFIX",
] as const;

export type ManagedEnvKey = (typeof MANAGED_ENV_KEYS)[number];

export type SecretSource = "1password" | "env" | "missing";

const NON_SECRET_ENV_KEYS: ReadonlySet<ManagedEnvKey> = new Set<ManagedEnvKey>([
  "B2_REGION",
  "B2_BUCKET",
  "B2_ENDPOINT",
  "B2_ARCHIVE_PREFIX",
]);

function isManagedEnvKey(key: string): key is ManagedEnvKey {
  return (MANAGED_ENV_KEYS as readonly string[]).includes(key);
}

export function isSecretEnvKey(key: ManagedEnvKey): boolean {
  return !NON_SECRET_ENV_KEYS.has(key);
}

export function maskEnvValue(value: string): string {
  const prefixLength = Math.min(6, Math.max(2, value.length));
  return `${value.slice(0, prefixLength)}${"*".repeat(8)}`;
}

/** Raised on rejected writes. Messages never include the secret value. */
export class SecretWriteError extends Error {}

interface SecretStoreOptions {
  envPath?: string;
  processEnv?: NodeJS.ProcessEnv;
}

export interface SecretStore {
  /** Snapshot pre-set keys, then load `.env` without overriding (dotenv semantics). Idempotent. */
  loadDotenv(): void;
  getValue(key: ManagedEnvKey): string | undefined;
  getSource(key: ManagedEnvKey): SecretSource;
  /** Write a value into `.env` and the live environment. Throws SecretWriteError on violations. */
  setEnvSecret(key: ManagedEnvKey, value: string): Promise<void>;
}

function hasControlCharacters(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function formatEnvValue(value: string): string {
  const needsQuoting = /[#'"\s]/.test(value);
  if (!needsQuoting) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  throw new SecretWriteError("value cannot contain both single and double quotes");
}

/** Replace the last `KEY=...` line (last one wins in dotenv) or append. Other lines are untouched. */
function upsertEnvLine(raw: string, key: ManagedEnvKey, newLine: string): string {
  const lines = raw.split("\n");
  const matcher = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  let lastIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (matcher.test(lines[i])) lastIndex = i;
  }
  if (lastIndex >= 0) {
    lines[lastIndex] = newLine;
    return lines.join("\n");
  }
  if (raw === "") return `${newLine}\n`;
  return raw.endsWith("\n") ? `${raw}${newLine}\n` : `${raw}\n${newLine}\n`;
}

function defaultEnvPath(): string {
  return process.env.VIDEOBOOK_ENV_PATH
    ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../.env");
}

export function createSecretStore(options: SecretStoreOptions = {}): SecretStore {
  const envPath = options.envPath ?? defaultEnvPath();
  const processEnv = options.processEnv ?? process.env;
  const preSet = new Set<ManagedEnvKey>();
  let loaded = false;

  function readEnvFileSync(): string {
    try {
      return readFileSync(envPath, "utf8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw err;
    }
  }

  function loadDotenv(): void {
    if (loaded) return;
    loaded = true;
    for (const key of MANAGED_ENV_KEYS) {
      const value = processEnv[key];
      if (value !== undefined && value !== "") preSet.add(key);
    }
    const parsed = parse(readEnvFileSync());
    for (const [key, value] of Object.entries(parsed)) {
      if (processEnv[key] === undefined) processEnv[key] = value;
    }
  }

  function getValue(key: ManagedEnvKey): string | undefined {
    loadDotenv();
    return processEnv[key];
  }

  function getSource(key: ManagedEnvKey): SecretSource {
    loadDotenv();
    const value = processEnv[key];
    if (!value || value.startsWith("op://")) return "missing";
    if (preSet.has(key)) return "1password";
    return "env";
  }

  async function setEnvSecret(key: ManagedEnvKey, rawValue: string): Promise<void> {
    loadDotenv();
    if (!isManagedEnvKey(key)) {
      throw new SecretWriteError(`${String(key)} is not a managed environment key`);
    }
    const value = rawValue.trim();
    if (!value) throw new SecretWriteError(`${key} value is empty`);
    if (hasControlCharacters(value)) {
      throw new SecretWriteError(`${key} value contains control characters`);
    }
    if (getSource(key) === "1password") {
      throw new SecretWriteError(`${key} is managed by 1Password; edit it in the vault`);
    }

    const line = `${key}=${formatEnvValue(value)}`;
    let raw: string;
    try {
      raw = await readFile(envPath, "utf8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      raw = "";
    }
    const updated = upsertEnvLine(raw, key, line);
    const tmp = `${envPath}.tmp.${randomUUID()}`;
    await writeFile(tmp, updated, "utf8");
    await rename(tmp, envPath);
    processEnv[key] = value;
  }

  return { loadDotenv, getValue, getSource, setEnvSecret };
}

let defaultStore: SecretStore | null = null;

export function getDefaultSecretStore(): SecretStore {
  if (!defaultStore) defaultStore = createSecretStore();
  return defaultStore;
}

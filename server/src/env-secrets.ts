/**
 * Secret-source detection and .env editing.
 *
 * Secrets reach the server three ways:
 *   1. `op run --env-file=.env.tpl --` resolves op:// references and injects
 *      them into the environment BEFORE Node starts (npm run dev:server).
 *   2. A plain `.env` file, loaded here with dotenv semantics: never override
 *      a var that is already set, so op-injected values always win.
 *   3. op:// references left in the environment or `.env`, plus every
 *      env-named item in the vault named by VIDEOBOOK_OP_VAULT, resolved
 *      through the 1Password CLI by resolveOnePassword() before a server
 *      starts.
 *
 * A managed key that was already set before `.env` loaded, or that 1Password
 * resolved, is therefore "1password" — externally managed and read-only,
 * because a `.env` write would be silently shadowed on the next start. A key
 * whose literal value arrived via `.env` is "env" and editable. A
 * shell-exported var is also classified "1password"; the label is
 * approximate but the read-only behavior is right.
 *
 * `.env` lives in the data home (the repo root in a source checkout) and is
 * server runtime configuration, not a project artifact, so direct node:fs is
 * correct here — the videobook-engine rule covers managed artifacts and their
 * materialized workspaces.
 */
import { dataLayout } from "./data-home.js";
import { hasControlCharacters, readEnvValues, updateEnvFile } from "./env-file.js";
import { resolveOnePasswordEnv, type OnePasswordResolution } from "./one-password.js";

export const MANAGED_ENV_KEYS = [
  "OPENAI_API_KEY",
  "KIE_API_KEY",
  "XAI_API_KEY",
  "X_CLIENT_ID",
  "X_CLIENT_SECRET",
  "DROPBOX_CLIENT_ID",
  "DROPBOX_CLIENT_SECRET",
  "KIMI_CODING_API_KEY",
  "FAL_API_KEY",
  "FAL_ADMIN_API_KEY",
  "DASHSCOPE_API_KEY",
  "ELEVENLABS_API_KEY",
  "MACHGEN_API_KEY",
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
  /** Resolve op:// references and the configured vault convention through the 1Password CLI, once. */
  resolveOnePassword(): OnePasswordResolution;
  /** The last resolveOnePassword() result, or null when it has not run. */
  onePasswordResolution(): OnePasswordResolution | null;
  /** The .env file this store reads and writes. */
  envPath(): string;
}

function defaultEnvPath(): string {
  return process.env.VIDEOBOOK_ENV_PATH ?? dataLayout().envPath;
}

export function createSecretStore(options: SecretStoreOptions = {}): SecretStore {
  const envPath = options.envPath ?? defaultEnvPath();
  const processEnv = options.processEnv ?? process.env;
  const preSet = new Set<ManagedEnvKey>();
  const fromOnePassword = new Set<string>();
  let loaded = false;
  let resolution: OnePasswordResolution | null = null;

  function loadDotenv(): void {
    if (loaded) return;
    loaded = true;
    for (const key of MANAGED_ENV_KEYS) {
      const value = processEnv[key];
      if (value !== undefined && value !== "") preSet.add(key);
    }
    for (const [key, value] of Object.entries(readEnvValues(envPath))) {
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
    if (preSet.has(key) || fromOnePassword.has(key)) return "1password";
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

    if (value.includes("'") && value.includes("\"")) {
      throw new SecretWriteError("value cannot contain both single and double quotes");
    }
    await updateEnvFile(envPath, { [key]: value });
    processEnv[key] = value;
  }

  function resolveOnePassword(): OnePasswordResolution {
    if (resolution) return resolution;
    loadDotenv();
    const resolved = resolveOnePasswordEnv(processEnv);
    for (const key of [...resolved.fromReferences, ...resolved.fromVault]) fromOnePassword.add(key);
    resolution = resolved;
    return resolved;
  }

  return {
    loadDotenv,
    getValue,
    getSource,
    setEnvSecret,
    resolveOnePassword,
    onePasswordResolution: () => resolution,
    envPath: () => envPath,
  };
}

let defaultStore: SecretStore | null = null;

export function getDefaultSecretStore(): SecretStore {
  if (!defaultStore) defaultStore = createSecretStore();
  return defaultStore;
}

import { z } from "zod";
import {
  MANAGED_ENV_KEYS,
  getDefaultSecretStore,
  isSecretEnvKey,
  maskEnvValue,
  type ManagedEnvKey,
  type SecretStore,
} from "../env-secrets.js";
import type { ToolDef } from "./tool-def.js";

/**
 * Writes a managed key into the repo-root .env file. Runs inline (no job
 * queue): it is sub-millisecond local file I/O, like rename_project.
 *
 * This tool intentionally has no book_id argument, so withLogging never
 * persists its args into git-versioned project activity logs — the secret
 * value must not leak there, and success/error results never echo it either.
 */
export function setEnvSecretDef(store: SecretStore = getDefaultSecretStore()): ToolDef {
  return {
    name: "set_env_secret",
    description:
      "Write a secret into the server's .env file and live environment. Rejects keys managed by 1Password (edit those in the vault). Never returns the secret value.",
    schema: {
      key: z.enum(MANAGED_ENV_KEYS).describe("Environment variable name to set"),
      value: z.string().min(1).describe("New value; stored in .env, never echoed back"),
    },
    handler: async (args) => {
      const { key, value } = args as { key: ManagedEnvKey; value: string };
      try {
        await store.setEnvSecret(key, value);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: message }],
        };
      }
      const stored = store.getValue(key) ?? value;
      const maskedKey = isSecretEnvKey(key) ? maskEnvValue(stored) : stored;
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ key, source: "env", maskedKey }) },
        ],
      };
    },
  };
}

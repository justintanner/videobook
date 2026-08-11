import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach } from "vitest";

const testRoot = process.env.VIDEOBOOK_TEST_ROOT;
if (testRoot) {
  const fileRoot = join(
    testRoot,
    `worker-${process.env.VITEST_POOL_ID ?? "0"}`,
    randomUUID(),
  );
  process.env.VIDEOBOOK_LIBRARY_DIR = join(fileRoot, "books");
  process.env.VIDEOBOOK_APP_STATE_PATH = join(fileRoot, "runtime", "app-state.json");
}

/**
 * Test guardrails: zero real API keys, zero outbound network.
 *
 * Runs once per vitest worker before any test file imports. Two layers:
 *   1. Delete every known provider/secret env var so a forgotten cleanup in a
 *      test can't pick up a developer's shell-exported key.
 *   2. Replace global fetch with one that throws on non-localhost so a test
 *      that does smuggle in a stub key still can't reach a real API.
 *
 * If a test legitimately needs a recorded provider response, route it through
 * PollyJS rather than relaxing the guard.
 */

const SECRET_ENV_VARS = [
  "DASHSCOPE_API_KEY",
  "ELEVENLABS_API_KEY",
  "FAL_API_KEY",
  "KIE_API_KEY",
  "KIMI_CODING_API_KEY",
  "OPENAI_API_KEY",
  "XAI_API_KEY",
  "X_ACCESS_TOKEN",
  "X_CLIENT_ID",
  "X_CLIENT_SECRET",
];

// Not secrets, but a developer's real local ACE-Step install must not leak into
// availability-gate tests; tests that need these set them explicitly.
const ACESTEP_ENV_VARS = [
  "VIDEOBOOK_ACESTEP_BASE_URL",
  "VIDEOBOOK_ACESTEP_SERVER_PATH",
  "VIDEOBOOK_ACESTEP_MODELS_DIR",
  "VIDEOBOOK_ACESTEP_PORT",
  "VIDEOBOOK_ACESTEP_MODEL",
  "VIDEOBOOK_ACESTEP_KEEP_LOADED",
];

for (const name of [...SECRET_ENV_VARS, ...ACESTEP_ENV_VARS]) {
  delete process.env[name];
}

function isLocalHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname === ""
  );
}

function extractFetchHost(input: RequestInfo | URL): string {
  if (input instanceof URL) return input.hostname;
  if (typeof input === "string") {
    try {
      return new URL(input).hostname;
    } catch {
      return "";
    }
  }
  try {
    return new URL((input as Request).url).hostname;
  } catch {
    return "";
  }
}

const realFetch = globalThis.fetch;
let blockedFetchAttempts: string[] = [];

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const host = extractFetchHost(input);
  if (isLocalHost(host)) return realFetch(input, init);
  blockedFetchAttempts.push(host || String(input));
  throw new Error(
    `[test guard] fetch to "${host}" blocked: tests must not make outbound API calls. ` +
      `Use PollyJS for recorded provider responses.`,
  );
}) as typeof fetch;

afterEach(() => {
  if (blockedFetchAttempts.length === 0) return;
  const hosts = [...new Set(blockedFetchAttempts)].join(", ");
  blockedFetchAttempts = [];
  throw new Error(`[test guard] outbound API fetch attempted during test: ${hosts}`);
});

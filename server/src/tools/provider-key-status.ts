import { createElevenLabs, type ElevenLabsUserSubscriptionResponse } from "@apicity/elevenlabs";
import { createKie } from "@apicity/kie";
import { createOpenAi } from "@apicity/openai";
import { createXai } from "@apicity/xai";
import { isPlaceholderApiKey } from "../api-key.js";
import {
  getDefaultSecretStore,
  isSecretEnvKey,
  maskEnvValue,
  type ManagedEnvKey,
  type SecretSource,
  type SecretStore,
} from "../env-secrets.js";
import type { ToolDef } from "./tool-def.js";

type KeyStatus = "configured" | "missing" | "placeholder";
type LookupStatus = "ok" | "missing_key" | "placeholder_key" | "error" | "unavailable";
type ProviderGroup =
  | "kie"
  | "elevenlabs"
  | "openai"
  | "xai"
  | "x"
  | "kimicoding"
  | "fal"
  | "dashscope"
  | "google"
  | "b2";
type LiveLookup = "kie-credits" | "elevenlabs-credits" | "openai-tokens" | "xai-tokens";

interface CreditLookupResult {
  value: number;
  message: string | null;
}

interface CreditsInfo {
  status: LookupStatus;
  value: number | null;
  unit: "credits";
  fetchedAt: string | null;
  message: string | null;
}

interface TokenLookupInfo {
  status: LookupStatus;
  value: number | null;
  unit: "tokens";
  model: string | null;
  fetchedAt: string | null;
  message: string | null;
}

interface ProviderKeyInfo {
  envKey: ManagedEnvKey;
  provider: ProviderGroup;
  label: string;
  keyStatus: KeyStatus;
  maskedKey: string | null;
  secret: boolean;
  source: SecretSource;
  editable: boolean;
  credits: CreditsInfo;
  tokenLookup: TokenLookupInfo;
}

interface ProviderKeyStatusResponse {
  providers: ProviderKeyInfo[];
}

interface KeyRegistryEntry {
  provider: ProviderGroup;
  label: string;
  live?: LiveLookup;
}

// Row order: live-checked providers first, then the rest grouped by provider.
const KEY_REGISTRY: Record<ManagedEnvKey, KeyRegistryEntry> = {
  KIE_API_KEY: { provider: "kie", label: "Kie", live: "kie-credits" },
  ELEVENLABS_API_KEY: { provider: "elevenlabs", label: "ElevenLabs", live: "elevenlabs-credits" },
  OPENAI_API_KEY: { provider: "openai", label: "OpenAI", live: "openai-tokens" },
  XAI_API_KEY: { provider: "xai", label: "xAI", live: "xai-tokens" },
  X_CLIENT_ID: { provider: "x", label: "X OAuth" },
  X_CLIENT_SECRET: { provider: "x", label: "X OAuth" },
  KIMI_CODING_API_KEY: { provider: "kimicoding", label: "Kimi Coding" },
  FAL_API_KEY: { provider: "fal", label: "FAL" },
  DASHSCOPE_API_KEY: { provider: "dashscope", label: "DashScope" },
  GOOGLE_FLOW_API_KEY: { provider: "google", label: "Google Flow" },
  B2_ACCESS_KEY_ID: { provider: "b2", label: "Backblaze B2" },
  B2_SECRET_ACCESS_KEY: { provider: "b2", label: "Backblaze B2" },
  B2_REGION: { provider: "b2", label: "Backblaze B2" },
  B2_BUCKET: { provider: "b2", label: "Backblaze B2" },
  B2_ENDPOINT: { provider: "b2", label: "Backblaze B2" },
  B2_ARCHIVE_PREFIX: { provider: "b2", label: "Backblaze B2" },
};

const ROW_ORDER: readonly ManagedEnvKey[] = [
  "KIE_API_KEY",
  "ELEVENLABS_API_KEY",
  "OPENAI_API_KEY",
  "XAI_API_KEY",
  "X_CLIENT_ID",
  "X_CLIENT_SECRET",
  "KIMI_CODING_API_KEY",
  "FAL_API_KEY",
  "DASHSCOPE_API_KEY",
  "GOOGLE_FLOW_API_KEY",
  "B2_ACCESS_KEY_ID",
  "B2_SECRET_ACCESS_KEY",
  "B2_REGION",
  "B2_BUCKET",
  "B2_ENDPOINT",
  "B2_ARCHIVE_PREFIX",
];

type CreditReader = (apiKey: string) => Promise<number | CreditLookupResult>;
type TokenReader = (apiKey: string) => Promise<TokenLookupResult>;

interface TokenLookupResult {
  value: number;
  model: string;
}

export interface ProviderKeyStatusDeps {
  store?: SecretStore;
  readKieCredits?: CreditReader;
  readOpenAiTokens?: TokenReader;
  readXaiTokens?: TokenReader;
  readElevenLabsCredits?: CreditReader;
}

const TOKEN_LOOKUP_TEXT = "Videocity token lookup";
const OPENAI_TOKEN_LOOKUP_MODEL = "gpt-5.4";
const XAI_TOKEN_LOOKUP_MODEL = "grok-4.20-reasoning";

function sanitizeMessage(error: unknown, apiKey: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return apiKey ? message.replaceAll(apiKey, "[redacted]") : message;
}

async function readKieCredits(apiKey: string): Promise<number> {
  const provider = createKie({ apiKey, timeout: 30_000 });
  const response = await provider.get.api.v1.chat.credit();
  if (response.code !== 200) {
    throw new Error(`Kie credit endpoint returned ${response.code}: ${response.msg}`);
  }
  if (typeof response.data !== "number") {
    throw new Error("Kie credit endpoint did not return a numeric balance");
  }
  return response.data;
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatElevenLabsSubscriptionMessage(subscription: ElevenLabsUserSubscriptionResponse): string {
  const remaining = formatInteger(subscription.remaining_character_count);
  const limit = formatInteger(subscription.character_limit);
  const used = formatInteger(subscription.character_count);
  return `${subscription.tier} plan: ${remaining} of ${limit} characters remaining (${used} used)`;
}

async function readElevenLabsCredits(apiKey: string): Promise<CreditLookupResult> {
  const provider = createElevenLabs({ apiKey, timeout: 30_000 });
  const subscription = await provider.v1.user.subscription();

  if (!Number.isFinite(subscription.remaining_character_count)) {
    throw new Error("ElevenLabs subscription endpoint did not return a numeric remaining character count");
  }

  return {
    value: subscription.remaining_character_count,
    message: formatElevenLabsSubscriptionMessage(subscription),
  };
}

async function readOpenAiTokens(apiKey: string): Promise<TokenLookupResult> {
  const provider = createOpenAi({ apiKey, timeout: 30_000 });
  const response = await provider.post.v1.responses.inputTokens({
    model: OPENAI_TOKEN_LOOKUP_MODEL,
    input: TOKEN_LOOKUP_TEXT,
  });
  return {
    value: response.input_tokens,
    model: OPENAI_TOKEN_LOOKUP_MODEL,
  };
}

async function readXaiTokens(apiKey: string): Promise<TokenLookupResult> {
  const provider = createXai({ apiKey, timeout: 30_000 });
  const response = await provider.post.v1.tokenizeText({
    model: XAI_TOKEN_LOOKUP_MODEL,
    text: TOKEN_LOOKUP_TEXT,
  });
  return {
    value: response.token_ids.length,
    model: XAI_TOKEN_LOOKUP_MODEL,
  };
}

function creditsInfo(status: LookupStatus, message: string | null): CreditsInfo {
  return { status, value: null, unit: "credits", fetchedAt: null, message };
}

function tokenLookupInfo(status: LookupStatus, message: string | null): TokenLookupInfo {
  return { status, value: null, unit: "tokens", model: null, fetchedAt: null, message };
}

function unavailableCredits(message: string): CreditsInfo {
  return creditsInfo("unavailable", message);
}

function unavailableTokenLookup(message: string): TokenLookupInfo {
  return tokenLookupInfo("unavailable", message);
}

const NO_CREDITS_MESSAGE = "Credit balance is not available for this provider";
const NO_TOKEN_LOOKUP_MESSAGE = "Token lookup is not available for this provider";

interface KeyBase {
  envKey: ManagedEnvKey;
  provider: ProviderGroup;
  label: string;
  keyStatus: KeyStatus;
  maskedKey: string | null;
  secret: boolean;
  source: SecretSource;
  editable: boolean;
}

function buildKeyBase(envKey: ManagedEnvKey, store: SecretStore): { base: KeyBase; value: string | null } {
  const entry = KEY_REGISTRY[envKey];
  const source = store.getSource(envKey);
  const secret = isSecretEnvKey(envKey);
  const raw = store.getValue(envKey);
  const value = !raw || raw.startsWith("op://") ? null : raw;

  let keyStatus: KeyStatus = "configured";
  if (value === null) keyStatus = "missing";
  else if (isPlaceholderApiKey(value)) keyStatus = "placeholder";

  const maskedKey =
    keyStatus !== "configured" || value === null
      ? null
      : secret
        ? maskEnvValue(value)
        : value;

  return {
    base: {
      envKey,
      provider: entry.provider,
      label: entry.label,
      keyStatus,
      maskedKey,
      secret,
      source,
      editable: source !== "1password",
    },
    value: keyStatus === "configured" ? value : null,
  };
}

function statusOnlyInfo(base: KeyBase): ProviderKeyInfo {
  if (base.keyStatus === "missing") {
    const message = `${base.envKey} environment variable is not set`;
    return { ...base, credits: creditsInfo("missing_key", message), tokenLookup: tokenLookupInfo("missing_key", message) };
  }
  if (base.keyStatus === "placeholder") {
    const message = `${base.envKey} is a placeholder; refusing to call the real API`;
    return { ...base, credits: creditsInfo("placeholder_key", message), tokenLookup: tokenLookupInfo("placeholder_key", message) };
  }
  return {
    ...base,
    credits: unavailableCredits(NO_CREDITS_MESSAGE),
    tokenLookup: unavailableTokenLookup(NO_TOKEN_LOOKUP_MESSAGE),
  };
}

function normalizeCreditLookupResult(result: number | CreditLookupResult): CreditLookupResult {
  if (typeof result === "number") {
    return { value: result, message: null };
  }
  return result;
}

async function creditLookupInfo(base: KeyBase, apiKey: string, readCredits: CreditReader): Promise<ProviderKeyInfo> {
  const tokenLookup = unavailableTokenLookup(NO_TOKEN_LOOKUP_MESSAGE);
  try {
    const result = normalizeCreditLookupResult(await readCredits(apiKey));
    return {
      ...base,
      credits: {
        status: "ok",
        value: result.value,
        unit: "credits",
        fetchedAt: new Date().toISOString(),
        message: result.message,
      },
      tokenLookup,
    };
  } catch (error) {
    return {
      ...base,
      credits: creditsInfo("error", sanitizeMessage(error, apiKey)),
      tokenLookup,
    };
  }
}

async function tokenLookupKeyInfo(base: KeyBase, apiKey: string, readTokens: TokenReader): Promise<ProviderKeyInfo> {
  const credits = unavailableCredits(NO_CREDITS_MESSAGE);
  try {
    const result = await readTokens(apiKey);
    return {
      ...base,
      credits,
      tokenLookup: {
        status: "ok",
        value: result.value,
        unit: "tokens",
        model: result.model,
        fetchedAt: new Date().toISOString(),
        message: null,
      },
    };
  } catch (error) {
    return {
      ...base,
      credits,
      tokenLookup: tokenLookupInfo("error", sanitizeMessage(error, apiKey)),
    };
  }
}

export async function getProviderKeyStatus(deps: ProviderKeyStatusDeps = {}): Promise<ProviderKeyStatusResponse> {
  const store = deps.store ?? getDefaultSecretStore();
  const creditReaders: Record<"kie-credits" | "elevenlabs-credits", CreditReader> = {
    "kie-credits": deps.readKieCredits ?? readKieCredits,
    "elevenlabs-credits": deps.readElevenLabsCredits ?? readElevenLabsCredits,
  };
  const tokenReaders: Record<"openai-tokens" | "xai-tokens", TokenReader> = {
    "openai-tokens": deps.readOpenAiTokens ?? readOpenAiTokens,
    "xai-tokens": deps.readXaiTokens ?? readXaiTokens,
  };

  const providers = await Promise.all(
    ROW_ORDER.map((envKey) => {
      const { base, value } = buildKeyBase(envKey, store);
      const live = KEY_REGISTRY[envKey].live;
      if (!live || value === null) return Promise.resolve(statusOnlyInfo(base));
      if (live === "kie-credits" || live === "elevenlabs-credits") {
        return creditLookupInfo(base, value, creditReaders[live]);
      }
      return tokenLookupKeyInfo(base, value, tokenReaders[live]);
    }),
  );

  return { providers };
}

export function providerKeyStatusDef(deps: ProviderKeyStatusDeps = {}): ToolDef {
  return {
    name: "provider_key_status",
    description:
      "List all managed environment keys with their source (1password = injected via op run, read-only; env = from .env, editable), masked values, and live credit/token lookups for supported providers. Never exposes secret values.",
    schema: {},
    handler: async () => ({
      content: [{ type: "text" as const, text: JSON.stringify(await getProviderKeyStatus(deps)) }],
    }),
  };
}

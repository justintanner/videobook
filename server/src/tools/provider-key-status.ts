import { createElevenLabs, type ElevenLabsUserSubscriptionResponse } from "@apicity/elevenlabs";
import { createKie } from "@apicity/kie";
import { createOpenAi } from "@apicity/openai";
import { createXai } from "@apicity/xai";
import { isPlaceholderApiKey } from "../api-key.js";
import type { ToolDef } from "./tool-def.js";

type KeyStatus = "configured" | "missing" | "placeholder";
type LookupStatus = "ok" | "missing_key" | "placeholder_key" | "error" | "unavailable";
type Provider = "kie" | "elevenlabs" | "openai" | "xai";
type ProviderEnvKey = "KIE_API_KEY" | "ELEVENLABS_API_KEY" | "OPENAI_API_KEY" | "XAI_API_KEY";
type ProviderLabel = "Kie" | "ElevenLabs" | "OpenAI" | "xAI";

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
  provider: Provider;
  label: ProviderLabel;
  envKey: ProviderEnvKey;
  keyStatus: KeyStatus;
  maskedKey: string | null;
  credits: CreditsInfo;
  tokenLookup: TokenLookupInfo;
}

interface ProviderKeyStatusResponse {
  providers: ProviderKeyInfo[];
}

interface ProviderConfig {
  provider: Provider;
  label: ProviderLabel;
  envKey: ProviderEnvKey;
}

type CreditReader = (apiKey: string) => Promise<number | CreditLookupResult>;
type TokenReader = (apiKey: string) => Promise<TokenLookupResult>;

interface TokenLookupResult {
  value: number;
  model: string;
}

const TOKEN_LOOKUP_TEXT = "Videocity token lookup";
const OPENAI_TOKEN_LOOKUP_MODEL = "gpt-5.4";
const XAI_TOKEN_LOOKUP_MODEL = "grok-4.20-reasoning";

function maskKey(apiKey: string): string {
  const prefixLength = Math.min(6, Math.max(2, apiKey.length));
  return `${apiKey.slice(0, prefixLength)}${"*".repeat(8)}`;
}

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

function unavailableCredits(message: string): CreditsInfo {
  return {
    status: "unavailable",
    value: null,
    unit: "credits",
    fetchedAt: null,
    message,
  };
}

function unavailableTokenLookup(message: string): TokenLookupInfo {
  return {
    status: "unavailable",
    value: null,
    unit: "tokens",
    model: null,
    fetchedAt: null,
    message,
  };
}

function getMissingProvider(config: ProviderConfig): ProviderKeyInfo {
  return {
    ...config,
    keyStatus: "missing",
    maskedKey: null,
    credits: {
      status: "missing_key",
      value: null,
      unit: "credits",
      fetchedAt: null,
      message: `${config.envKey} environment variable is not set`,
    },
    tokenLookup: {
      status: "missing_key",
      value: null,
      unit: "tokens",
      model: null,
      fetchedAt: null,
      message: `${config.envKey} environment variable is not set`,
    },
  };
}

function getPlaceholderProvider(config: ProviderConfig): ProviderKeyInfo {
  return {
    ...config,
    keyStatus: "placeholder",
    maskedKey: null,
    credits: {
      status: "placeholder_key",
      value: null,
      unit: "credits",
      fetchedAt: null,
      message: `${config.envKey} is a placeholder; refusing to call the real API`,
    },
    tokenLookup: {
      status: "placeholder_key",
      value: null,
      unit: "tokens",
      model: null,
      fetchedAt: null,
      message: `${config.envKey} is a placeholder; refusing to call the real API`,
    },
  };
}

function getConfiguredProviderBase(config: ProviderConfig, apiKey: string): Omit<ProviderKeyInfo, "credits" | "tokenLookup"> {
  return {
    ...config,
    keyStatus: "configured",
    maskedKey: maskKey(apiKey),
  };
}

function normalizeCreditLookupResult(result: number | CreditLookupResult): CreditLookupResult {
  if (typeof result === "number") {
    return { value: result, message: null };
  }
  return result;
}

async function getCreditProvider(config: ProviderConfig, readCredits: CreditReader): Promise<ProviderKeyInfo> {
  const apiKey = process.env[config.envKey];

  if (!apiKey) return getMissingProvider(config);
  if (isPlaceholderApiKey(apiKey)) return getPlaceholderProvider(config);

  const base = getConfiguredProviderBase(config, apiKey);

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
      tokenLookup: unavailableTokenLookup("Token lookup is not available for this provider"),
    };
  } catch (error) {
    return {
      ...base,
      credits: {
        status: "error",
        value: null,
        unit: "credits",
        fetchedAt: null,
        message: sanitizeMessage(error, apiKey),
      },
      tokenLookup: unavailableTokenLookup("Token lookup is not available for this provider"),
    };
  }
}

async function getTokenProvider(config: ProviderConfig, readTokens: TokenReader): Promise<ProviderKeyInfo> {
  const apiKey = process.env[config.envKey];

  if (!apiKey) return getMissingProvider(config);
  if (isPlaceholderApiKey(apiKey)) return getPlaceholderProvider(config);

  const base = getConfiguredProviderBase(config, apiKey);

  try {
    const result = await readTokens(apiKey);
    return {
      ...base,
      credits: unavailableCredits("Credit balance is not available for this provider"),
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
      credits: unavailableCredits("Credit balance is not available for this provider"),
      tokenLookup: {
        status: "error",
        value: null,
        unit: "tokens",
        model: null,
        fetchedAt: null,
        message: sanitizeMessage(error, apiKey),
      },
    };
  }
}

export async function getProviderKeyStatus(
  readKieCreditsFn: CreditReader = readKieCredits,
  readOpenAiTokensFn: TokenReader = readOpenAiTokens,
  readXaiTokensFn: TokenReader = readXaiTokens,
  readElevenLabsCreditsFn: CreditReader = readElevenLabsCredits,
): Promise<ProviderKeyStatusResponse> {
  const kie: ProviderConfig = { provider: "kie", label: "Kie", envKey: "KIE_API_KEY" };
  const elevenlabs: ProviderConfig = { provider: "elevenlabs", label: "ElevenLabs", envKey: "ELEVENLABS_API_KEY" };
  const openai: ProviderConfig = { provider: "openai", label: "OpenAI", envKey: "OPENAI_API_KEY" };
  const xai: ProviderConfig = { provider: "xai", label: "xAI", envKey: "XAI_API_KEY" };

  const providers = await Promise.all([
    getCreditProvider(kie, readKieCreditsFn),
    getCreditProvider(elevenlabs, readElevenLabsCreditsFn),
    getTokenProvider(openai, readOpenAiTokensFn),
    getTokenProvider(xai, readXaiTokensFn),
  ]);

  return { providers };
}

export function providerKeyStatusDef(): ToolDef {
  return {
    name: "provider_key_status",
    description: "List configured provider API keys, live credit balances, and token lookups without exposing secret values",
    schema: {},
    handler: async () => ({
      content: [{ type: "text" as const, text: JSON.stringify(await getProviderKeyStatus()) }],
    }),
  };
}

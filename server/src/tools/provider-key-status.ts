import { createKie } from "@apicity/kie";
import { isPlaceholderApiKey } from "../api-key.js";
import type { ToolDef } from "./tool-def.js";

type KeyStatus = "configured" | "missing" | "placeholder";
type CreditsStatus = "ok" | "missing_key" | "placeholder_key" | "error" | "unavailable";
type Provider = "kie" | "elevenlabs" | "openai" | "xai";
type ProviderEnvKey = "KIE_API_KEY" | "ELEVENLABS_API_KEY" | "OPENAI_API_KEY" | "XAI_API_KEY";
type ProviderLabel = "Kie" | "ElevenLabs" | "OpenAI" | "xAI";

interface CreditsInfo {
  status: CreditsStatus;
  value: number | null;
  unit: "credits";
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
}

interface ProviderKeyStatusResponse {
  providers: ProviderKeyInfo[];
}

interface ProviderConfig {
  provider: Provider;
  label: ProviderLabel;
  envKey: ProviderEnvKey;
}

type CreditReader = (apiKey: string) => Promise<number>;

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
  };
}

function getConfiguredProviderBase(config: ProviderConfig, apiKey: string): Omit<ProviderKeyInfo, "credits"> {
  return {
    ...config,
    keyStatus: "configured",
    maskedKey: maskKey(apiKey),
  };
}

async function getCreditProvider(config: ProviderConfig, readCredits: CreditReader): Promise<ProviderKeyInfo> {
  const apiKey = process.env[config.envKey];

  if (!apiKey) return getMissingProvider(config);
  if (isPlaceholderApiKey(apiKey)) return getPlaceholderProvider(config);

  const base = getConfiguredProviderBase(config, apiKey);

  try {
    const value = await readCredits(apiKey);
    return {
      ...base,
      credits: {
        status: "ok",
        value,
        unit: "credits",
        fetchedAt: new Date().toISOString(),
        message: null,
      },
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
    };
  }
}

function getKeyOnlyProvider(config: ProviderConfig): ProviderKeyInfo {
  const apiKey = process.env[config.envKey];

  if (!apiKey) return getMissingProvider(config);
  if (isPlaceholderApiKey(apiKey)) return getPlaceholderProvider(config);

  return {
    ...getConfiguredProviderBase(config, apiKey),
    credits: {
      status: "unavailable",
      value: null,
      unit: "credits",
      fetchedAt: null,
      message: "Credit balance is not available for this provider",
    },
  };
}

export async function getProviderKeyStatus(readKieCreditsFn: CreditReader = readKieCredits): Promise<ProviderKeyStatusResponse> {
  const kie: ProviderConfig = { provider: "kie", label: "Kie", envKey: "KIE_API_KEY" };
  const elevenlabs: ProviderConfig = { provider: "elevenlabs", label: "ElevenLabs", envKey: "ELEVENLABS_API_KEY" };
  const openai: ProviderConfig = { provider: "openai", label: "OpenAI", envKey: "OPENAI_API_KEY" };
  const xai: ProviderConfig = { provider: "xai", label: "xAI", envKey: "XAI_API_KEY" };

  return {
    providers: [
      await getCreditProvider(kie, readKieCreditsFn),
      getKeyOnlyProvider(elevenlabs),
      getKeyOnlyProvider(openai),
      getKeyOnlyProvider(xai),
    ],
  };
}

export function providerKeyStatusDef(): ToolDef {
  return {
    name: "provider_key_status",
    description: "List configured provider API keys and live credit balances without exposing secret values",
    schema: {},
    handler: async () => ({
      content: [{ type: "text" as const, text: JSON.stringify(await getProviderKeyStatus()) }],
    }),
  };
}

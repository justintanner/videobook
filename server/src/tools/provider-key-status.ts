import { createKie } from "@apicity/kie";
import { isPlaceholderApiKey } from "../api-key.js";
import type { ToolDef } from "./tool-def.js";

type KeyStatus = "configured" | "missing" | "placeholder";
type CreditsStatus = "ok" | "missing_key" | "placeholder_key" | "error";

interface CreditsInfo {
  status: CreditsStatus;
  value: number | null;
  unit: "credits";
  fetchedAt: string | null;
  message: string | null;
}

interface ProviderKeyInfo {
  provider: "kie";
  label: "Kie";
  envKey: "KIE_API_KEY";
  keyStatus: KeyStatus;
  maskedKey: string | null;
  credits: CreditsInfo;
}

interface ProviderKeyStatusResponse {
  providers: ProviderKeyInfo[];
}

type KieCreditReader = (apiKey: string) => Promise<number>;

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

export async function getProviderKeyStatus(readCredits: KieCreditReader = readKieCredits): Promise<ProviderKeyStatusResponse> {
  const apiKey = process.env.KIE_API_KEY;

  if (!apiKey) {
    return {
      providers: [{
        provider: "kie",
        label: "Kie",
        envKey: "KIE_API_KEY",
        keyStatus: "missing",
        maskedKey: null,
        credits: {
          status: "missing_key",
          value: null,
          unit: "credits",
          fetchedAt: null,
          message: "KIE_API_KEY environment variable is not set",
        },
      }],
    };
  }

  if (isPlaceholderApiKey(apiKey)) {
    return {
      providers: [{
        provider: "kie",
        label: "Kie",
        envKey: "KIE_API_KEY",
        keyStatus: "placeholder",
        maskedKey: null,
        credits: {
          status: "placeholder_key",
          value: null,
          unit: "credits",
          fetchedAt: null,
          message: "KIE_API_KEY is a placeholder; refusing to call the real API",
        },
      }],
    };
  }

  const base: Omit<ProviderKeyInfo, "credits"> = {
    provider: "kie",
    label: "Kie",
    envKey: "KIE_API_KEY",
    keyStatus: "configured",
    maskedKey: maskKey(apiKey),
  };

  try {
    const value = await readCredits(apiKey);
    return {
      providers: [{
        ...base,
        credits: {
          status: "ok",
          value,
          unit: "credits",
          fetchedAt: new Date().toISOString(),
          message: null,
        },
      }],
    };
  } catch (error) {
    return {
      providers: [{
        ...base,
        credits: {
          status: "error",
          value: null,
          unit: "credits",
          fetchedAt: null,
          message: sanitizeMessage(error, apiKey),
        },
      }],
    };
  }
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

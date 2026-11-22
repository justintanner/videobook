import type { ResolvedModel } from "../types.js";
import { alibabaAdapterFor } from "./alibaba.js";
import { elevenLabsAdapter } from "./elevenlabs.js";
import { falAdapter } from "./fal.js";
import { googleAdapterFor } from "./google.js";
import { googleFlowAdapterFor } from "./googleflow.js";
import { kieAdapter } from "./kie.js";
import { machgenAdapterFor } from "./machgen.js";
import { nunchuxAdapterFor } from "./nunchux.js";
import { openAiAdapter } from "./openai.js";
import type { ProviderAdapter } from "./types.js";
import { wavespeedAdapter } from "./wavespeed.js";
import { xaiAdapter } from "./xai.js";

export function adapterFor(model: ResolvedModel): ProviderAdapter {
  switch (model.provider) {
    case "kie":
      return kieAdapter;
    case "fal":
      return falAdapter;
    case "xai":
      return xaiAdapter;
    case "alibaba":
      return alibabaAdapterFor(model.apiId);
    case "elevenlabs":
      return elevenLabsAdapter;
    case "machgen":
      return machgenAdapterFor(model.apiId);
    case "wavespeed":
      return wavespeedAdapter;
    case "nunchux":
      return nunchuxAdapterFor(model.apiId);
    case "openai":
      return openAiAdapter;
    case "google":
      return googleAdapterFor(model.apiId);
    case "googleflow":
      return googleFlowAdapterFor(model.apiId);
  }
}

export const PROVIDER_ENV_KEYS: Readonly<Record<ResolvedModel["provider"], string>> = {
  kie: "KIE_API_KEY",
  fal: "FAL_API_KEY",
  xai: "XAI_API_KEY",
  alibaba: "DASHSCOPE_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
  machgen: "MACHGEN_API_KEY",
  wavespeed: "WAVESPEED_API_KEY",
  nunchux: "NUNCHUX_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_SERVICE_ACCOUNT_JSON",
  googleflow: "GOOGLE_FLOW_API_KEY",
};

export function providerEnvKey(model: ResolvedModel): string {
  return adapterFor(model).envKey;
}

import type { ResolvedModel } from "../types.js";
import { alibabaAdapterFor } from "./alibaba.js";
import { elevenLabsAdapter } from "./elevenlabs.js";
import { falAdapter } from "./fal.js";
import { googleFlowAdapter } from "./googleflow.js";
import { kieAdapter } from "./kie.js";
import type { ProviderAdapter } from "./types.js";
import { xaiAdapter } from "./xai.js";

export function adapterFor(model: ResolvedModel): ProviderAdapter {
  switch (model.provider) {
    case "kie":
      return kieAdapter;
    case "fal":
      return falAdapter;
    case "xai":
      return xaiAdapter;
    case "googleflow":
      return googleFlowAdapter;
    case "alibaba":
      return alibabaAdapterFor(model.apiId);
    case "elevenlabs":
      return elevenLabsAdapter;
  }
}

export const PROVIDER_ENV_KEYS: Readonly<Record<ResolvedModel["provider"], string>> = {
  kie: "KIE_API_KEY",
  fal: "FAL_API_KEY",
  xai: "XAI_API_KEY",
  googleflow: "GOOGLE_FLOW_API_KEY",
  alibaba: "DASHSCOPE_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
};

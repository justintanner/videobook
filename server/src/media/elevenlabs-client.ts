import { createElevenLabs } from "../usage-providers.js";
import { providerEndpoints } from "./endpoints.js";

export function elevenLabsClient(options: {
  apiKey: string;
  timeout: number;
}): ReturnType<typeof createElevenLabs> {
  const baseURL = providerEndpoints().elevenlabsBaseURL;
  return createElevenLabs({
    apiKey: options.apiKey,
    timeout: options.timeout,
    ...(baseURL ? { baseURL } : {}),
  });
}

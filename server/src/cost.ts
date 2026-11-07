import { estimateEndpoint } from "@apicity/cost";
import type { EndpointEstimate } from "@apicity/cost";

export function forecastLanguageCall(model: string, input: string, maxOutputTokens = 1000): EndpointEstimate {
  return estimateEndpoint({
    provider: "openai", method: "POST", dotPath: "v1.responses", mode: "forecast",
    payload: { model, input, max_output_tokens: maxOutputTokens },
  });
}

import { createOpenAi, withRetry } from "@apicity/openai";
import type {
  OpenAiResponseRequest,
  OpenAiResponseResponse,
} from "@apicity/openai";

export const INTELLIGENCE_MODEL = "gpt-5.6-sol";
export const INTELLIGENCE_REASONING_EFFORT = "medium";
export const OPENAI_ANALYSIS_TOOL = "openai_responses_analysis";

export type IntelligenceReasoningEffort = NonNullable<
  OpenAiResponseRequest["reasoning"]
>["effort"];

export const ANALYSIS_REASONING_EFFORT: IntelligenceReasoningEffort = "high";

export type ResponsesFn = (
  request: OpenAiResponseRequest,
  signal?: AbortSignal,
) => Promise<OpenAiResponseResponse>;

export type IntelligenceRequest = Omit<
  OpenAiResponseRequest,
  "model" | "reasoning" | "store" | "temperature" | "top_p"
>;

type IntelligenceResponsesOptions = {
  timeout?: number;
  retries?: number;
  fetch?: typeof fetch;
  baseURL?: string;
};

type IntelligenceRequestOptions = {
  reasoningEffort?: IntelligenceReasoningEffort;
};

export function intelligenceRequest(
  request: IntelligenceRequest,
  options: IntelligenceRequestOptions = {},
): OpenAiResponseRequest {
  return {
    ...request,
    model: INTELLIGENCE_MODEL,
    reasoning: {
      effort: options.reasoningEffort ?? INTELLIGENCE_REASONING_EFFORT,
    },
    store: false,
  };
}

function normalizeRequest(request: OpenAiResponseRequest): OpenAiResponseRequest {
  const normalized = intelligenceRequest(request, {
    reasoningEffort:
      request.reasoning?.effort ?? INTELLIGENCE_REASONING_EFFORT,
  });
  delete normalized.temperature;
  delete normalized.top_p;
  return normalized;
}

export function buildIntelligenceResponses(
  apiKey: string | undefined,
  options: IntelligenceResponsesOptions = {},
): ResponsesFn {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const timeout = options.timeout ?? 180_000;
  const provider = createOpenAi({
    apiKey,
    timeout,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
  });
  const call = withRetry<OpenAiResponseRequest, OpenAiResponseResponse>(
    provider.post.v1.responses,
    { retries: options.retries ?? 2, baseMs: 500 },
  );

  return async (request, signal) => {
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new Error(`OpenAI Responses request exceeded ${timeout}ms`)),
      timeout,
    );
    const combinedSignal = signal
      ? AbortSignal.any([signal, deadline.signal])
      : deadline.signal;

    try {
      return await call(normalizeRequest(request), combinedSignal);
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error("OpenAI Responses request was cancelled");
      }
      if (deadline.signal.aborted) {
        throw deadline.signal.reason instanceof Error
          ? deadline.signal.reason
          : new Error(`OpenAI Responses request exceeded ${timeout}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}

export function firstResponseText(response: OpenAiResponseResponse): string {
  if (response.error) {
    throw new Error(`OpenAI Responses error ${response.error.code}: ${response.error.message}`);
  }
  if (response.status === "incomplete") {
    const reason = response.incomplete_details?.reason ?? "unknown reason";
    throw new Error(`OpenAI Responses output was incomplete: ${reason}`);
  }
  if (response.status !== "completed") {
    throw new Error(`OpenAI Responses request did not complete (status=${response.status})`);
  }

  const texts: string[] = [];
  for (const item of response.output) {
    if (item.type !== "message") continue;
    for (const content of item.content) {
      if (content.type === "refusal") {
        throw new Error(`OpenAI Responses refused the request: ${content.refusal}`);
      }
      if (content.type === "output_text") {
        texts.push(content.text);
      }
    }
  }

  const text = texts.join("").trim();
  if (!text) {
    throw new Error("OpenAI Responses returned no text content");
  }
  return text;
}

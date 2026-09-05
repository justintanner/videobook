import { describe, expect, it } from "vitest";
import type { OpenAiResponseRequest } from "@apicity/openai";
import {
  CHAT_MODEL_OPTIONS,
  DEFAULT_CHAT_MODEL,
  chatIntelligenceRequestOptions,
  listChatModelsDef,
  resolveChatModel,
} from "./chat-models.js";
import {
  INTELLIGENCE_MODEL,
  buildIntelligenceResponses,
  intelligenceRequest,
} from "./openai-intelligence.js";

describe("chat models", () => {
  it("uses Astra for every chat routing request", () => {
    expect(DEFAULT_CHAT_MODEL).toBe("gpt-6-astra");
    expect(CHAT_MODEL_OPTIONS.map((model) => model.id)).toEqual(["gpt-6-astra"]);
    expect(resolveChatModel(undefined)).toMatchObject({
      id: "gpt-6-astra",
      label: "Astra",
      reasoningEffort: "medium",
    });
    expect(INTELLIGENCE_MODEL).toBe("gpt-5.6-sol");
  });

  it("publishes a client-safe catalog through MCP", async () => {
    const result = await listChatModelsDef().handler({});
    const catalog = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(catalog).toEqual({
      defaultModel: "gpt-6-astra",
      models: CHAT_MODEL_OPTIONS.map(({ id, label, description }) => ({
        id,
        label,
        description,
      })),
    });
  });

  it("builds chat Responses requests with Astra, medium reasoning, and no sampling params", async () => {
    const options = chatIntelligenceRequestOptions(undefined);
    let captured: OpenAiResponseRequest | undefined;
    const doFetch = (async (_input, init) => {
      captured = JSON.parse(String(init?.body)) as OpenAiResponseRequest;
      return new Response(JSON.stringify({
        id: "resp_chat",
        object: "response",
        created_at: 1,
        status: "completed",
        model: options.model,
        output: [{
          type: "message",
          id: "msg_chat",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "{}", annotations: [] }],
        }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const responses = buildIntelligenceResponses("test-key", {
      fetch: doFetch,
      retries: 0,
      timeout: 1_000,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
    });

    await responses(intelligenceRequest({
      instructions: "Route this request.",
      input: "extract audio from b2 and use it to replace the audio on the video in c4",
      text: { format: { type: "json_object" } },
      max_output_tokens: 2048,
    }, options));

    expect(options).toEqual({
      model: "gpt-6-astra",
      reasoningEffort: "medium",
    });
    expect(captured?.model).toBe("gpt-6-astra");
    expect(captured?.reasoning).toEqual({ effort: "medium" });
    expect(captured?.store).toBe(false);
    expect(captured).not.toHaveProperty("temperature");
    expect(captured).not.toHaveProperty("top_p");
    expect(captured).not.toHaveProperty("top_logprobs");
    expect(INTELLIGENCE_MODEL).toBe("gpt-5.6-sol");
  });
});

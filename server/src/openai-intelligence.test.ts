import { describe, expect, it } from "vitest";
import type {
  OpenAiResponseRequest,
  OpenAiResponseResponse,
} from "@apicity/openai";
import {
  INTELLIGENCE_MODEL,
  INTELLIGENCE_REASONING_EFFORT,
  buildIntelligenceResponses,
  firstResponseText,
  intelligenceRequest,
} from "./openai-intelligence.js";

function response(
  overrides: Partial<OpenAiResponseResponse> = {},
): OpenAiResponseResponse {
  return {
    id: "resp_test",
    object: "response",
    created_at: 1,
    status: "completed",
    model: INTELLIGENCE_MODEL,
    output: [{
      type: "message",
      id: "msg_test",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "done", annotations: [] }],
    }],
    ...overrides,
  };
}

describe("intelligenceRequest", () => {
  it("sets the shared model, medium reasoning, and stateless execution", () => {
    expect(intelligenceRequest({ input: "Analyze this." })).toEqual({
      input: "Analyze this.",
      model: INTELLIGENCE_MODEL,
      reasoning: { effort: INTELLIGENCE_REASONING_EFFORT },
      store: false,
    });
  });

  it("preserves multimodal structured-output requests", () => {
    const request = intelligenceRequest({
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: "Describe the frame." },
          { type: "input_image", image_url: "data:image/jpeg;base64,YQ==", detail: "high" },
        ],
      }],
      text: {
        format: {
          type: "json_schema",
          name: "description",
          schema: {
            type: "object",
            properties: { description: { type: "string" } },
            required: ["description"],
            additionalProperties: false,
          },
          strict: true,
        },
      },
    });

    expect(request.model).toBe("gpt-5.6-sol");
    expect(request.reasoning).toEqual({ effort: "medium" });
    expect(request.store).toBe(false);
    expect(request.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user" }),
    ]));
  });

  it("supports a high-reasoning override without changing the shared default", () => {
    expect(intelligenceRequest(
      { input: "Verify camera cuts." },
      { reasoningEffort: "high" },
    )).toMatchObject({
      model: "gpt-5.6-sol",
      reasoning: { effort: "high" },
      store: false,
    });
    expect(INTELLIGENCE_REASONING_EFFORT).toBe("medium");
  });
});

describe("buildIntelligenceResponses", () => {
  it("uses the Apicity Responses endpoint and enforces shared defaults", async () => {
    let captured: OpenAiResponseRequest | undefined;
    const doFetch = (async (_input, init) => {
      captured = JSON.parse(String(init?.body)) as OpenAiResponseRequest;
      return new Response(JSON.stringify(response()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const responses = buildIntelligenceResponses("test-key", {
      fetch: doFetch,
      retries: 0,
      timeout: 1_000,
    });

    await responses({
      model: "legacy-model",
      input: "Analyze this.",
      temperature: 0.5,
      top_p: 0.8,
    });

    expect(captured?.model).toBe("gpt-5.6-sol");
    expect(captured?.reasoning).toEqual({ effort: "medium" });
    expect(captured?.store).toBe(false);
    expect(captured).not.toHaveProperty("temperature");
    expect(captured).not.toHaveProperty("top_p");
  });

  it("preserves a supported reasoning override through the provider wrapper", async () => {
    let captured: OpenAiResponseRequest | undefined;
    const doFetch = (async (_input, init) => {
      captured = JSON.parse(String(init?.body)) as OpenAiResponseRequest;
      return new Response(JSON.stringify(response()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const responses = buildIntelligenceResponses("test-key", {
      fetch: doFetch,
      retries: 0,
      timeout: 1_000,
    });

    await responses(intelligenceRequest(
      { input: "Verify camera cuts." },
      { reasoningEffort: "high" },
    ));

    expect(captured?.reasoning).toEqual({ effort: "high" });
  });

  it("honors an external abort signal", async () => {
    const doFetch = (async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
    const responses = buildIntelligenceResponses("test-key", {
      fetch: doFetch,
      retries: 0,
      timeout: 1_000,
    });
    const controller = new AbortController();
    const pending = responses(intelligenceRequest({ input: "Analyze this." }), controller.signal);
    controller.abort(new Error("cancelled by caller"));

    await expect(pending).rejects.toThrow("cancelled by caller");
  });

  it("enforces one deadline across the request", async () => {
    const doFetch = (async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
    const responses = buildIntelligenceResponses("test-key", {
      fetch: doFetch,
      retries: 2,
      timeout: 20,
    });

    await expect(responses(intelligenceRequest({ input: "Analyze this." })))
      .rejects.toThrow("OpenAI Responses request exceeded 20ms");
  });
});

describe("firstResponseText", () => {
  it("joins only assistant output text", () => {
    expect(firstResponseText(response({
      output: [
        {
          type: "function_call",
          id: "call_test",
          call_id: "call_test",
          name: "ignored",
          arguments: "{}",
          status: "completed",
        },
        {
          type: "message",
          id: "msg_test",
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: "first", annotations: [] },
            { type: "output_text", text: " second", annotations: [] },
          ],
        },
      ],
    }))).toBe("first second");
  });

  it("surfaces failed responses", () => {
    expect(() => firstResponseText(response({
      status: "failed",
      error: { code: "server_error", message: "try again" },
      output: [],
    }))).toThrow("OpenAI Responses error server_error: try again");
  });

  it("surfaces incomplete responses", () => {
    expect(() => firstResponseText(response({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [],
    }))).toThrow("OpenAI Responses output was incomplete: max_output_tokens");
  });

  it("surfaces refusals", () => {
    expect(() => firstResponseText(response({
      output: [{
        type: "message",
        id: "msg_test",
        role: "assistant",
        status: "completed",
        content: [{ type: "refusal", refusal: "not allowed" }],
      }],
    }))).toThrow("OpenAI Responses refused the request: not allowed");
  });
});

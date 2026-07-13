import { describe, expect, it } from "vitest";
import type { KieGemini35FlashStreamGenerateContentResult } from "@apicity/kie";
import {
  collectGeminiFlashContent,
  geminiFlashResponseText,
  geminiFlashAuthFetch,
  invokeStreamingWithFallback,
  isGeminiThoughtPart,
  normalizeGeminiJsonText,
  sliceFirstJsonValue,
  toGeminiResponseSchema,
} from "./kie-gemini.js";

describe("normalizeGeminiJsonText", () => {
  it("strips markdown JSON fences", () => {
    expect(normalizeGeminiJsonText("```json\n{\"ok\":true}\n```")).toBe("{\"ok\":true}");
  });

  it("extracts the JSON payload from surrounding text", () => {
    expect(normalizeGeminiJsonText("Here is the JSON:\n{\"visuals\":[]}\nDone.")).toBe("{\"visuals\":[]}");
  });

  it("leaves plain JSON unchanged", () => {
    expect(normalizeGeminiJsonText("{\"visuals\":[]}")).toBe("{\"visuals\":[]}");
  });

  it("takes the first object when two JSON values are concatenated", () => {
    const first = "{\"tool\":\"list_assets\",\"params\":{},\"message\":\"Listing assets.\"}";
    const second = "{\"tool\":\"trim_video\",\"params\":{\"asset_id\":\"vid-x\"},\"message\":\"Trimming.\"}";
    const raw = `${first}${second}`;
    expect(normalizeGeminiJsonText(raw)).toBe(first);
    expect(JSON.parse(normalizeGeminiJsonText(raw))).toEqual({
      tool: "list_assets",
      params: {},
      message: "Listing assets.",
    });
  });

  it("handles nested braces and strings with braces", () => {
    const raw = "prefix {\"a\":{\"b\":1},\"c\":\"}not close\"} trailing {\"d\":2}";
    expect(normalizeGeminiJsonText(raw)).toBe("{\"a\":{\"b\":1},\"c\":\"}not close\"}");
  });
});

describe("sliceFirstJsonValue", () => {
  it("returns null for incomplete JSON", () => {
    expect(sliceFirstJsonValue("{\"a\":1", 0)).toBeNull();
  });
});

describe("isGeminiThoughtPart", () => {
  it("detects thought parts", () => {
    expect(isGeminiThoughtPart({ thought: true, text: "reasoning" })).toBe(true);
    expect(isGeminiThoughtPart({ text: "answer" })).toBe(false);
  });
});

describe("toGeminiResponseSchema", () => {
  it("strips additionalProperties recursively while preserving the rest", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["visuals"],
      properties: {
        visuals: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["visual"],
            properties: { visual: { type: "string" } },
          },
        },
      },
    };
    expect(toGeminiResponseSchema(schema)).toEqual({
      type: "object",
      required: ["visuals"],
      properties: {
        visuals: {
          type: "array",
          items: {
            type: "object",
            required: ["visual"],
            properties: { visual: { type: "string" } },
          },
        },
      },
    });
  });

  it("returns primitives unchanged", () => {
    expect(toGeminiResponseSchema("x")).toBe("x");
    expect(toGeminiResponseSchema(3)).toBe(3);
    expect(toGeminiResponseSchema(null)).toBe(null);
  });
});

describe("geminiFlashResponseText", () => {
  it("throws application-level Kie errors", () => {
    expect(() => geminiFlashResponseText({
      code: 401,
      msg: "Unauthorized",
    })).toThrow("Kie Gemini API error 401: Unauthorized");
  });

  it("returns an empty string when no text content is present", () => {
    expect(geminiFlashResponseText({ candidates: [] })).toBe("");
  });

  it("skips thought parts so answer JSON is not polluted", () => {
    const text = geminiFlashResponseText({
      candidates: [{
        content: {
          parts: [
            { thought: true, text: "I will route to list_assets." },
            { text: "{\"tool\":\"list_assets\",\"params\":{},\"message\":\"Listing.\"}" },
          ],
        },
      }],
    });
    expect(text).toBe("{\"tool\":\"list_assets\",\"params\":{},\"message\":\"Listing.\"}");
    expect(JSON.parse(text)).toEqual({
      tool: "list_assets",
      params: {},
      message: "Listing.",
    });
  });
});

describe("geminiFlashAuthFetch", () => {
  it("rewrites Gemini Flash requests to Kie bearer auth", async () => {
    let capturedHeaders = new Headers();
    const fakeFetch = (async (_input, init) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const wrapped = geminiFlashAuthFetch("kie-test-key", fakeFetch);
    await wrapped("https://api.kie.ai/gemini/v1/models/gemini-3-5-flash:streamGenerateContent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": "kie-test-key",
      },
    });

    expect(capturedHeaders.get("Authorization")).toBe("Bearer kie-test-key");
    expect(capturedHeaders.get("Content-Type")).toBe("application/json");
    expect(capturedHeaders.has("X-Goog-Api-Key")).toBe(false);
  });

  it("leaves other Kie requests unchanged", async () => {
    let capturedHeaders = new Headers();
    const fakeFetch = (async (_input, init) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const wrapped = geminiFlashAuthFetch("kie-test-key", fakeFetch);
    await wrapped("https://api.kie.ai/api/v1/chat/credit", {
      headers: { Authorization: "Bearer original" },
    });

    expect(capturedHeaders.get("Authorization")).toBe("Bearer original");
  });
});

describe("collectGeminiFlashContent", () => {
  const chunkFor = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] });

  async function* streamChunks(texts: string[]): AsyncGenerator<unknown> {
    for (const t of texts) yield chunkFor(t);
  }

  // An async iterable that yields one chunk then stalls until `signal` aborts,
  // at which point it rejects with the abort reason — mirroring how a real fetch
  // body stream terminates the for-await when its signal is aborted.
  function stallingStream(first: string, signal: AbortSignal): AsyncIterable<unknown> {
    return {
      [Symbol.asyncIterator]() {
        let sent = false;
        return {
          next() {
            if (!sent) {
              sent = true;
              return Promise.resolve({ value: chunkFor(first), done: false });
            }
            return new Promise((_resolve, reject) => {
              if (signal.aborted) { reject(signal.reason); return; }
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          },
        };
      },
    };
  }

  it("concatenates streamed chunks and fires onDelta cumulatively", async () => {
    const deltas: string[] = [];
    const text = await collectGeminiFlashContent(
      streamChunks(["Hello", "World"]) as unknown as KieGemini35FlashStreamGenerateContentResult,
      (t) => deltas.push(t),
    );
    expect(text).toBe("HelloWorld");
    expect(deltas).toEqual(["Hello", "HelloWorld"]);
  });

  it("aborts a stalled stream after the idle timeout, preserving text seen so far", async () => {
    const controller = new AbortController();
    const deltas: string[] = [];
    await expect(collectGeminiFlashContent(
      stallingStream("partial", controller.signal) as unknown as KieGemini35FlashStreamGenerateContentResult,
      (t) => deltas.push(t),
      { ms: 20, onIdle: () => controller.abort(new Error("Kie stream idle")) },
    )).rejects.toThrow("Kie stream idle");
    expect(deltas).toEqual(["partial"]);
  });
});

describe("invokeStreamingWithFallback", () => {
  it("returns the streamed result when streaming succeeds", async () => {
    const calls: boolean[] = [];
    const invoke = async (stream: boolean) => {
      calls.push(stream);
      return stream ? "streamed" : "oneshot";
    };
    expect(await invokeStreamingWithFallback(invoke)).toBe("streamed");
    expect(calls).toEqual([true]);
  });

  it("retries the stream, then falls back to one-shot on repeated stream failures", async () => {
    const calls: boolean[] = [];
    const invoke = async (stream: boolean) => {
      calls.push(stream);
      if (stream) throw new Error("Kie Gemini API error 500: Server exception, please try again later");
      return "oneshot";
    };
    expect(await invokeStreamingWithFallback(invoke)).toBe("oneshot");
    // Two streaming attempts, then a single one-shot fallback.
    expect(calls).toEqual([true, true, false]);
  });

  it("treats an empty stream as a failure and falls back", async () => {
    const calls: boolean[] = [];
    const invoke = async (stream: boolean) => {
      calls.push(stream);
      return stream ? "" : "oneshot";
    };
    expect(await invokeStreamingWithFallback(invoke)).toBe("oneshot");
    expect(calls).toEqual([true, true, false]);
  });
});

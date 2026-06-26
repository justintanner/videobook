import { describe, expect, it } from "vitest";
import {
  geminiFlashResponseText,
  geminiFlashAuthFetch,
  normalizeGeminiJsonText,
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

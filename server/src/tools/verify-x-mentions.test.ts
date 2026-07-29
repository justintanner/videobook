import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { buildIntelligenceResponses } from "../openai-intelligence.js";
import {
  extractXMentions,
  verifyXMentionsWithOpenAi,
  MENTION_VERIFICATION_MODEL,
} from "./verify-x-mentions.js";

describe("extractXMentions", () => {
  it("extracts handles and dedupes case-insensitively", () => {
    expect(extractXMentions("shoutout @JackMunro and @jackmunro plus @OtherOne"))
      .toEqual(["JackMunro", "OtherOne"]);
  });

  it("returns handles in order of first appearance", () => {
    expect(extractXMentions("@b_1 then @A9 then @b_1")).toEqual(["b_1", "A9"]);
  });

  it("ignores asset slugs, emails, and over-long tokens", () => {
    expect(extractXMentions("render @vid-outro-combo-final now")).toEqual([]);
    expect(extractXMentions("mail me jwt@hey.com")).toEqual([]);
    expect(extractXMentions("@a_very_long_handle_over_limit")).toEqual([]);
    expect(extractXMentions("@@double")).toEqual([]);
  });

  it("accepts handles at start, mid-sentence, and before punctuation", () => {
    expect(extractXMentions("@Lead kicks off")).toEqual(["Lead"]);
    expect(extractXMentions("word (@Paren) and @Comma, done.")).toEqual(["Paren", "Comma"]);
  });

  it("returns empty for text without mentions", () => {
    expect(extractXMentions("multicultural revolution")).toEqual([]);
  });
});

describe("verifyXMentionsWithOpenAi", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => error ? reject(error) : resolve());
      });
    }
    server = null;
  });

  async function listen(instance: Server): Promise<number> {
    return new Promise((resolve, reject) => {
      instance.once("error", reject);
      instance.listen(0, "127.0.0.1", () => {
        const address = instance.address();
        if (typeof address === "object" && address !== null) resolve(address.port);
        else reject(new Error("Local OpenAI server has no TCP address"));
      });
    });
  }

  it("requests live X search with structured output and maps verdicts by handle", async () => {
    let captured: Record<string, unknown> | null = null;
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (request.url !== "/responses") {
          response.statusCode = 404;
          response.end();
          return;
        }
        captured = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          id: "resp-123",
          object: "response",
          created_at: 1_752_900_000,
          completed_at: 1_752_900_010,
          status: "completed",
          model: MENTION_VERIFICATION_MODEL,
          output: [{
            type: "web_search_call",
            id: "ws-1",
            status: "completed",
          }, {
            type: "message",
            id: "msg-1",
            role: "assistant",
            status: "completed",
            content: [{
              type: "output_text",
              text: JSON.stringify({
                mentions: [
                  { handle: "@jackmunro", exists: true, display_name: "Jack Munro", summary: "Filmmaker posting mime history clips." },
                  { handle: "ghosthandle", exists: false, display_name: null, summary: null },
                ],
              }),
              annotations: [{
                type: "url_citation",
                start_index: 0,
                end_index: 1,
                url: "https://x.com/JackMunro",
                title: "Jack Munro (@JackMunro) on X",
              }],
            }],
          }],
          instructions: null,
          previous_response_id: null,
          temperature: null,
          top_p: null,
          max_output_tokens: null,
          store: true,
          tools: [],
          reasoning: null,
          text: { format: { type: "text" } },
          usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
          error: null,
          incomplete_details: null,
          metadata: {},
        }));
      });
    });
    const port = await listen(server);
    const responses = buildIntelligenceResponses("test-openai-key", {
      baseURL: `http://127.0.0.1:${port}`,
      timeout: 30_000,
      retries: 0,
    });

    const verification = await verifyXMentionsWithOpenAi(responses, ["JackMunro", "GhostHandle", "Unmentioned"]);

    expect(verification.mentions).toEqual([
      { handle: "JackMunro", exists: true, display_name: "Jack Munro", summary: "Filmmaker posting mime history clips." },
      { handle: "GhostHandle", exists: false, display_name: null, summary: null },
      { handle: "Unmentioned", exists: null, display_name: null, summary: null },
    ]);
    expect(verification.citations).toEqual(["https://x.com/JackMunro"]);
    expect(verification.model).toBe(MENTION_VERIFICATION_MODEL);

    expect(captured).not.toBeNull();
    const request = captured as unknown as {
      model: string;
      input: Array<{ role: string; content: string }>;
      tools: Array<{ type: string }>;
      search_parameters?: unknown;
      text: { format: { type: string; name: string } };
      reasoning: { effort: string };
      store: boolean;
    };
    expect(request.model).toBe(MENTION_VERIFICATION_MODEL);
    expect(request.tools).toEqual([{ type: "web_search_preview" }]);
    expect(request.search_parameters).toBeUndefined();
    expect(request.text.format.type).toBe("json_schema");
    expect(request.reasoning).toEqual({ effort: "medium" });
    expect(request.store).toBe(false);
    expect(request.input.some((message) => message.role === "user" && message.content.includes("@JackMunro, @GhostHandle, @Unmentioned"))).toBe(true);
  });

  it("throws when OpenAI refuses the request", async () => {
    server = createServer((request, response) => {
      request.on("data", () => {});
      request.on("end", () => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          id: "resp-456",
          object: "response",
          created_at: 1_752_900_000,
          completed_at: 1_752_900_010,
          status: "completed",
          model: MENTION_VERIFICATION_MODEL,
          output: [{
            type: "message",
            id: "msg-1",
            role: "assistant",
            status: "completed",
            content: [{ type: "refusal", refusal: "cannot verify" }],
          }],
          instructions: null,
          previous_response_id: null,
          temperature: null,
          top_p: null,
          max_output_tokens: null,
          store: true,
          tools: [],
          reasoning: null,
          text: { format: { type: "text" } },
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          error: null,
          incomplete_details: null,
          metadata: {},
        }));
      });
    });
    const port = await listen(server);
    const responses = buildIntelligenceResponses("test-openai-key", {
      baseURL: `http://127.0.0.1:${port}`,
      timeout: 30_000,
      retries: 0,
    });

    await expect(verifyXMentionsWithOpenAi(responses, ["JackMunro"]))
      .rejects.toThrow(/refused.*cannot verify/);
  });
});

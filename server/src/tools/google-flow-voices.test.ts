import { describe, it, expect, afterEach } from "vitest";
import { createGoogleFlow } from "@apicity/googleflow";
import {
  createGoogleFlowVoiceDef,
  listGoogleFlowVoicesDef,
  deleteGoogleFlowVoiceDef,
  createGoogleFlowVoice,
  listGoogleFlowVoices,
  deleteGoogleFlowVoice,
} from "./google-flow-voices.js";

type TextContent = Array<{ type: string; text: string }>;

function stubProvider(body: unknown, calls?: Array<{ url: string; method: string }>) {
  const fetchFn: typeof fetch = async (input, init) => {
    if (calls) calls.push({ url: String(input), method: init?.method ?? "GET" });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return createGoogleFlow({ apiKey: "test-token", fetch: fetchFn });
}

describe("google flow voice tools — handler guards", () => {
  const originalKey = process.env.GOOGLE_FLOW_API_KEY;
  afterEach(() => {
    if (originalKey) process.env.GOOGLE_FLOW_API_KEY = originalKey;
    else delete process.env.GOOGLE_FLOW_API_KEY;
  });

  it("errors cleanly when GOOGLE_FLOW_API_KEY is missing", async () => {
    delete process.env.GOOGLE_FLOW_API_KEY;
    const result = await createGoogleFlowVoiceDef().handler({
      voice: "Kore",
      display_name: "Narrator",
      dialog: "Once upon a time",
      voice_performance: "warm and slow",
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("GOOGLE_FLOW_API_KEY");
  });

  it("fails closed on a placeholder key rather than calling the real API", async () => {
    process.env.GOOGLE_FLOW_API_KEY = "test-key";
    const result = await listGoogleFlowVoicesDef().handler({});
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("placeholder");
  });

  it("delete fails closed on a placeholder key", async () => {
    process.env.GOOGLE_FLOW_API_KEY = "test-key";
    const result = await deleteGoogleFlowVoiceDef().handler({ ref: "user:1-voice:abc" });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("placeholder");
  });
});

describe("google flow voice tools — schema shape", () => {
  it("sources the 30-preset enum from GoogleFlowVoicePresetSchema", () => {
    const def = createGoogleFlowVoiceDef();
    const options = (def.schema.voice as unknown as { options: string[] }).options;
    expect(options).toHaveLength(30);
    expect(options).toContain("Kore");
    expect(options).toContain("Zephyr");
  });

  it("exposes user/system as the list source enum", () => {
    const def = listGoogleFlowVoicesDef();
    const source = def.schema.source as unknown as { unwrap: () => { options: string[] } };
    expect(source.unwrap().options.sort()).toEqual(["system", "user"]);
  });
});

describe("google flow voice cores — stubbed provider", () => {
  it("creates a voice and returns its ref", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const provider = stubProvider({ voice: "user:1-voice:abc" }, calls);
    const result = await createGoogleFlowVoice(provider, {
      voice: "Kore",
      displayName: "Narrator",
      dialog: "Once upon a time",
      voicePerformance: "warm and slow",
      email: "acct@x.com",
    });
    expect(result).toMatchObject({ voice_ref: "user:1-voice:abc", display_name: "Narrator", status: "created" });
    // explicit email means no /accounts lookup; exactly one POST /voices call
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toContain("/voices");
  });

  it("throws with the raw body when the create response carries no ref", async () => {
    const provider = stubProvider({ status: "queued" });
    await expect(
      createGoogleFlowVoice(provider, {
        voice: "Kore",
        displayName: "n",
        dialog: "hi",
        voicePerformance: "warm",
        email: "acct@x.com",
      }),
    ).rejects.toThrow(/no voice ref/);
  });

  it("lists voices into normalized entities", async () => {
    const provider = stubProvider({ voices: [{ voice: "v1", displayName: "Narrator" }] });
    const result = await listGoogleFlowVoices(provider, { email: "acct@x.com", source: "user" });
    expect(result).toMatchObject({ email: "acct@x.com", count: 1 });
    expect(result.voices[0]).toMatchObject({ ref: "v1", display_name: "Narrator" });
  });

  it("deletes a voice by ref", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const provider = stubProvider({ deleted: true }, calls);
    const result = await deleteGoogleFlowVoice(provider, "user:1-voice:abc");
    expect(result).toEqual({ ref: "user:1-voice:abc", status: "deleted" });
    expect(calls[0].method).toBe("DELETE");
  });
});

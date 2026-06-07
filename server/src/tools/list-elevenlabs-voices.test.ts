import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listElevenLabsVoices } from "./list-elevenlabs-voices.js";

describe("list_elevenlabs_voices", () => {
  const originalApiKey = process.env.ELEVENLABS_API_KEY;
  const originalCustomVoiceIds = process.env.ELEVENLABS_CUSTOM_VOICE_IDS;
  const originalCustomVoices = process.env.ELEVENLABS_CUSTOM_VOICES;

  beforeEach(() => {
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_CUSTOM_VOICE_IDS;
    delete process.env.ELEVENLABS_CUSTOM_VOICES;
  });

  afterEach(() => {
    if (originalApiKey) process.env.ELEVENLABS_API_KEY = originalApiKey;
    else delete process.env.ELEVENLABS_API_KEY;
    if (originalCustomVoiceIds) process.env.ELEVENLABS_CUSTOM_VOICE_IDS = originalCustomVoiceIds;
    else delete process.env.ELEVENLABS_CUSTOM_VOICE_IDS;
    if (originalCustomVoices) process.env.ELEVENLABS_CUSTOM_VOICES = originalCustomVoices;
    else delete process.env.ELEVENLABS_CUSTOM_VOICES;
  });

  it("returns configured custom IDs before generic fallback IDs without an API key", async () => {
    process.env.ELEVENLABS_CUSTOM_VOICE_IDS = "Narrator=custom-voice-1,custom-voice-2";

    const result = await listElevenLabsVoices();

    expect(result.status).toBe("fallback");
    expect(result.voices[0]).toMatchObject({ voice_id: "custom-voice-1", name: "Narrator", source: "custom" });
    expect(result.voices[1]).toMatchObject({ voice_id: "custom-voice-2", name: "custom-voice-2", source: "custom" });
    expect(result.voices[2]).toMatchObject({ source: "generic" });
  });

  it("orders env custom, account custom, then default voices from ElevenLabs", async () => {
    process.env.ELEVENLABS_API_KEY = "real-elevenlabs-key";
    process.env.ELEVENLABS_CUSTOM_VOICE_IDS = "Pinned=env-custom";
    const requestedTypes: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      const url = new URL(String(input));
      const voiceType = url.searchParams.get("voice_type") ?? "";
      requestedTypes.push(voiceType);
      const voices = voiceType === "non-default"
        ? [{ voice_id: "api-custom", name: "API Custom", category: "cloned" }]
        : [{ voice_id: "api-generic", name: "API Generic", category: "premade" }];
      return new Response(JSON.stringify({ voices, has_more: false, next_page_token: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const result = await listElevenLabsVoices(fetchFn);

    expect(requestedTypes.sort()).toEqual(["default", "non-default"]);
    expect(result.status).toBe("live");
    expect(result.voices.map((voice) => `${voice.source}:${voice.voice_id}`)).toEqual([
      "custom:env-custom",
      "custom:api-custom",
      "generic:api-generic",
    ]);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProviderKeyStatus } from "./provider-key-status.js";

describe("provider key status", () => {
  const originalKieKey = process.env.KIE_API_KEY;
  const originalElevenLabsKey = process.env.ELEVENLABS_API_KEY;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalXaiKey = process.env.XAI_API_KEY;

  beforeEach(() => {
    delete process.env.KIE_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.XAI_API_KEY;
  });

  afterEach(() => {
    if (originalKieKey) {
      process.env.KIE_API_KEY = originalKieKey;
    } else {
      delete process.env.KIE_API_KEY;
    }
    if (originalElevenLabsKey) {
      process.env.ELEVENLABS_API_KEY = originalElevenLabsKey;
    } else {
      delete process.env.ELEVENLABS_API_KEY;
    }
    if (originalOpenAiKey) {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
    if (originalXaiKey) {
      process.env.XAI_API_KEY = originalXaiKey;
    } else {
      delete process.env.XAI_API_KEY;
    }
  });

  it("returns missing status without calling Kie when KIE_API_KEY is not set", async () => {
    delete process.env.KIE_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.XAI_API_KEY;
    let called = false;

    const result = await getProviderKeyStatus(async () => {
      called = true;
      return 0;
    });

    expect(called).toBe(false);
    expect(result.providers[0]).toMatchObject({
      provider: "kie",
      envKey: "KIE_API_KEY",
      keyStatus: "missing",
      maskedKey: null,
      credits: { status: "missing_key", value: null },
      tokenLookup: { status: "missing_key", value: null },
    });
    expect(result.providers[1]).toMatchObject({
      provider: "elevenlabs",
      envKey: "ELEVENLABS_API_KEY",
      keyStatus: "missing",
      maskedKey: null,
      credits: { status: "missing_key", value: null },
      tokenLookup: { status: "missing_key", value: null },
    });
    expect(result.providers[2]).toMatchObject({
      provider: "openai",
      envKey: "OPENAI_API_KEY",
      keyStatus: "missing",
      maskedKey: null,
      credits: { status: "missing_key", value: null },
      tokenLookup: { status: "missing_key", value: null },
    });
    expect(result.providers[3]).toMatchObject({
      provider: "xai",
      envKey: "XAI_API_KEY",
      keyStatus: "missing",
      maskedKey: null,
      credits: { status: "missing_key", value: null },
      tokenLookup: { status: "missing_key", value: null },
    });
  });

  it("returns placeholder status without calling Kie for placeholder keys", async () => {
    process.env.KIE_API_KEY = "test-key-placeholder";
    let called = false;

    const result = await getProviderKeyStatus(async () => {
      called = true;
      return 0;
    });

    expect(called).toBe(false);
    expect(result.providers[0]).toMatchObject({
      keyStatus: "placeholder",
      maskedKey: null,
      credits: { status: "placeholder_key", value: null },
      tokenLookup: { status: "placeholder_key", value: null },
    });
  });

  it("returns live credit data for ElevenLabs with a masked key prefix", async () => {
    process.env.KIE_API_KEY = "real-looking-kie-key";
    const apiKey = "real-looking-elevenlabs-key";
    process.env.ELEVENLABS_API_KEY = apiKey;

    const result = await getProviderKeyStatus(
      async () => 10,
      async () => ({ value: 7, model: "gpt-test" }),
      async () => ({ value: 5, model: "grok-test" }),
      async (key) => {
        expect(key).toBe(apiKey);
        return {
          value: 1234,
          message: "creator plan: 1,234 of 10,000 characters remaining (8,766 used)",
        };
      },
    );

    const json = JSON.stringify(result);
    expect(json).not.toContain(apiKey);
    expect(result.providers[1]).toMatchObject({
      provider: "elevenlabs",
      label: "ElevenLabs",
      envKey: "ELEVENLABS_API_KEY",
      keyStatus: "configured",
      maskedKey: "real-l********",
      credits: {
        status: "ok",
        value: 1234,
        unit: "credits",
        message: "creator plan: 1,234 of 10,000 characters remaining (8,766 used)",
      },
      tokenLookup: {
        status: "unavailable",
        value: null,
        unit: "tokens",
        fetchedAt: null,
        message: "Token lookup is not available for this provider",
      },
    });
    expect(result.providers[1].credits.fetchedAt).toEqual(expect.any(String));
  });

  it("returns live token lookup status for OpenAI and xAI with masked key prefixes", async () => {
    process.env.KIE_API_KEY = "real-looking-kie-key";
    const openAiKey = "real-looking-openai-key";
    const xaiKey = "real-looking-xai-key";
    process.env.OPENAI_API_KEY = openAiKey;
    process.env.XAI_API_KEY = xaiKey;

    const result = await getProviderKeyStatus(
      async () => 10,
      async (key) => {
        expect(key).toBe(openAiKey);
        return { value: 7, model: "gpt-test" };
      },
      async (key) => {
        expect(key).toBe(xaiKey);
        return { value: 5, model: "grok-test" };
      },
    );

    const json = JSON.stringify(result);
    expect(json).not.toContain(openAiKey);
    expect(json).not.toContain(xaiKey);
    expect(result.providers[2]).toMatchObject({
      provider: "openai",
      label: "OpenAI",
      envKey: "OPENAI_API_KEY",
      keyStatus: "configured",
      maskedKey: "real-l********",
      credits: {
        status: "unavailable",
        value: null,
        unit: "credits",
        fetchedAt: null,
        message: "Credit balance is not available for this provider",
      },
      tokenLookup: {
        status: "ok",
        value: 7,
        unit: "tokens",
        model: "gpt-test",
        message: null,
      },
    });
    expect(result.providers[2].tokenLookup.fetchedAt).toEqual(expect.any(String));
    expect(result.providers[3]).toMatchObject({
      provider: "xai",
      label: "xAI",
      envKey: "XAI_API_KEY",
      keyStatus: "configured",
      maskedKey: "real-l********",
      credits: {
        status: "unavailable",
        value: null,
        unit: "credits",
        fetchedAt: null,
        message: "Credit balance is not available for this provider",
      },
      tokenLookup: {
        status: "ok",
        value: 5,
        unit: "tokens",
        model: "grok-test",
        message: null,
      },
    });
    expect(result.providers[3].tokenLookup.fetchedAt).toEqual(expect.any(String));
  });

  it("returns placeholder status for OpenAI and xAI placeholder keys", async () => {
    process.env.KIE_API_KEY = "real-looking-kie-key";
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.XAI_API_KEY = "test-xai-key";

    const result = await getProviderKeyStatus(async () => 10);

    expect(result.providers[2]).toMatchObject({
      keyStatus: "placeholder",
      maskedKey: null,
      credits: { status: "placeholder_key", value: null },
      tokenLookup: { status: "placeholder_key", value: null },
    });
    expect(result.providers[3]).toMatchObject({
      keyStatus: "placeholder",
      maskedKey: null,
      credits: { status: "placeholder_key", value: null },
      tokenLookup: { status: "placeholder_key", value: null },
    });
  });

  it("returns placeholder status for ElevenLabs placeholder keys", async () => {
    process.env.KIE_API_KEY = "real-looking-kie-key";
    process.env.ELEVENLABS_API_KEY = "test-elevenlabs-key";

    const result = await getProviderKeyStatus(async () => 10);

    expect(result.providers[1]).toMatchObject({
      keyStatus: "placeholder",
      maskedKey: null,
      credits: { status: "placeholder_key", value: null },
      tokenLookup: { status: "placeholder_key", value: null },
    });
  });

  it("returns live credit data with a masked key prefix", async () => {
    const apiKey = "real-looking-kie-key";
    process.env.KIE_API_KEY = apiKey;

    const result = await getProviderKeyStatus(async (key) => {
      expect(key).toBe(apiKey);
      return 123.45;
    });

    const json = JSON.stringify(result);
    expect(json).not.toContain(apiKey);
    expect(result.providers[0]).toMatchObject({
      keyStatus: "configured",
      maskedKey: "real-l********",
      credits: { status: "ok", value: 123.45, unit: "credits", message: null },
      tokenLookup: { status: "unavailable", value: null, unit: "tokens" },
    });
    expect(result.providers[0].credits.fetchedAt).toEqual(expect.any(String));
  });

  it("sanitizes credit endpoint errors", async () => {
    const apiKey = "real-looking-kie-key";
    process.env.KIE_API_KEY = apiKey;

    const result = await getProviderKeyStatus(async () => {
      throw new Error(`bad key ${apiKey}`);
    });

    const json = JSON.stringify(result);
    expect(json).not.toContain(apiKey);
    expect(result.providers[0].credits).toMatchObject({
      status: "error",
      value: null,
      message: "bad key [redacted]",
    });
  });

  it("sanitizes token lookup endpoint errors", async () => {
    const apiKey = "real-looking-openai-key";
    process.env.OPENAI_API_KEY = apiKey;

    const result = await getProviderKeyStatus(
      async () => 10,
      async () => {
        throw new Error(`bad key ${apiKey}`);
      },
      async () => ({ value: 5, model: "grok-test" }),
    );

    const json = JSON.stringify(result);
    expect(json).not.toContain(apiKey);
    expect(result.providers[2].tokenLookup).toMatchObject({
      status: "error",
      value: null,
      message: "bad key [redacted]",
    });
  });
});

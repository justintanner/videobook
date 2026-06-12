import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MANAGED_ENV_KEYS, createSecretStore, type SecretStore } from "../env-secrets.js";
import { getProviderKeyStatus } from "./provider-key-status.js";

describe("provider key status", () => {
  let dir: string;
  let envPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "provider-key-status-test-"));
    envPath = join(dir, ".env");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function makeStore(envFile: string, processEnv: NodeJS.ProcessEnv = {}): Promise<SecretStore> {
    await writeFile(envPath, envFile, "utf8");
    return createSecretStore({ envPath, processEnv });
  }

  it("returns one row per managed key with missing status when nothing is configured", async () => {
    const store = await makeStore("");
    let called = false;

    const result = await getProviderKeyStatus({
      store,
      readKieCredits: async () => {
        called = true;
        return 0;
      },
    });

    expect(called).toBe(false);
    expect(result.providers).toHaveLength(MANAGED_ENV_KEYS.length);
    expect(result.providers.map((p) => p.envKey).sort()).toEqual([...MANAGED_ENV_KEYS].sort());
    expect(result.providers[0]).toMatchObject({
      provider: "kie",
      envKey: "KIE_API_KEY",
      keyStatus: "missing",
      maskedKey: null,
      source: "missing",
      editable: true,
      secret: true,
      credits: { status: "missing_key", value: null },
      tokenLookup: { status: "missing_key", value: null },
    });
    for (const provider of result.providers) {
      expect(provider.source).toBe("missing");
      expect(provider.editable).toBe(true);
    }
  });

  it("marks .env-backed keys as env and editable", async () => {
    const store = await makeStore("FAL_API_KEY=real-looking-fal-key\nB2_BUCKET=my-bucket\n");

    const result = await getProviderKeyStatus({ store });
    const fal = result.providers.find((p) => p.envKey === "FAL_API_KEY");
    const bucket = result.providers.find((p) => p.envKey === "B2_BUCKET");

    expect(fal).toMatchObject({
      provider: "fal",
      keyStatus: "configured",
      maskedKey: "real-l********",
      secret: true,
      source: "env",
      editable: true,
      credits: { status: "unavailable" },
      tokenLookup: { status: "unavailable" },
    });
    expect(bucket).toMatchObject({
      provider: "b2",
      keyStatus: "configured",
      maskedKey: "my-bucket",
      secret: false,
      source: "env",
      editable: true,
    });
  });

  it("marks pre-set keys as 1password and not editable", async () => {
    const apiKey = "real-looking-openai-key";
    const store = await makeStore("", { OPENAI_API_KEY: apiKey });

    const result = await getProviderKeyStatus({
      store,
      readOpenAiTokens: async () => ({ value: 7, model: "gpt-test" }),
    });
    const openai = result.providers.find((p) => p.envKey === "OPENAI_API_KEY");

    expect(openai).toMatchObject({
      keyStatus: "configured",
      maskedKey: "real-l********",
      source: "1password",
      editable: false,
      tokenLookup: { status: "ok", value: 7, model: "gpt-test" },
    });
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it("treats unresolved op:// references as missing", async () => {
    const store = await makeStore("KIE_API_KEY=op://Apicity/KIE_API_KEY/password\n");

    const result = await getProviderKeyStatus({ store });
    const kie = result.providers.find((p) => p.envKey === "KIE_API_KEY");

    expect(kie).toMatchObject({
      keyStatus: "missing",
      maskedKey: null,
      source: "missing",
      credits: { status: "missing_key" },
    });
  });

  it("returns placeholder status without calling readers for placeholder keys", async () => {
    const store = await makeStore("KIE_API_KEY=test-key-placeholder\nOPENAI_API_KEY=test-openai-key\n");
    let called = false;

    const result = await getProviderKeyStatus({
      store,
      readKieCredits: async () => {
        called = true;
        return 0;
      },
      readOpenAiTokens: async () => {
        called = true;
        return { value: 1, model: "gpt-test" };
      },
    });

    expect(called).toBe(false);
    const kie = result.providers.find((p) => p.envKey === "KIE_API_KEY");
    const openai = result.providers.find((p) => p.envKey === "OPENAI_API_KEY");
    expect(kie).toMatchObject({
      keyStatus: "placeholder",
      maskedKey: null,
      source: "env",
      credits: { status: "placeholder_key", value: null },
      tokenLookup: { status: "placeholder_key", value: null },
    });
    expect(openai).toMatchObject({
      keyStatus: "placeholder",
      maskedKey: null,
      credits: { status: "placeholder_key", value: null },
      tokenLookup: { status: "placeholder_key", value: null },
    });
  });

  it("returns live credit data for Kie and ElevenLabs with masked key prefixes", async () => {
    const kieKey = "real-looking-kie-key";
    const elevenKey = "real-looking-elevenlabs-key";
    const store = await makeStore(`KIE_API_KEY=${kieKey}\nELEVENLABS_API_KEY=${elevenKey}\n`);

    const result = await getProviderKeyStatus({
      store,
      readKieCredits: async (key) => {
        expect(key).toBe(kieKey);
        return 123.45;
      },
      readElevenLabsCredits: async (key) => {
        expect(key).toBe(elevenKey);
        return {
          value: 1234,
          message: "creator plan: 1,234 of 10,000 characters remaining (8,766 used)",
        };
      },
    });

    const json = JSON.stringify(result);
    expect(json).not.toContain(kieKey);
    expect(json).not.toContain(elevenKey);
    expect(result.providers[0]).toMatchObject({
      provider: "kie",
      keyStatus: "configured",
      maskedKey: "real-l********",
      credits: { status: "ok", value: 123.45, unit: "credits", message: null },
      tokenLookup: { status: "unavailable", value: null, unit: "tokens" },
    });
    expect(result.providers[0].credits.fetchedAt).toEqual(expect.any(String));
    expect(result.providers[1]).toMatchObject({
      provider: "elevenlabs",
      label: "ElevenLabs",
      keyStatus: "configured",
      maskedKey: "real-l********",
      credits: {
        status: "ok",
        value: 1234,
        message: "creator plan: 1,234 of 10,000 characters remaining (8,766 used)",
      },
      tokenLookup: { status: "unavailable", value: null },
    });
  });

  it("returns live token lookups for OpenAI and xAI", async () => {
    const openAiKey = "real-looking-openai-key";
    const xaiKey = "real-looking-xai-key";
    const store = await makeStore(`OPENAI_API_KEY=${openAiKey}\nXAI_API_KEY=${xaiKey}\n`);

    const result = await getProviderKeyStatus({
      store,
      readOpenAiTokens: async (key) => {
        expect(key).toBe(openAiKey);
        return { value: 7, model: "gpt-test" };
      },
      readXaiTokens: async (key) => {
        expect(key).toBe(xaiKey);
        return { value: 5, model: "grok-test" };
      },
    });

    const json = JSON.stringify(result);
    expect(json).not.toContain(openAiKey);
    expect(json).not.toContain(xaiKey);
    expect(result.providers[2]).toMatchObject({
      provider: "openai",
      label: "OpenAI",
      keyStatus: "configured",
      maskedKey: "real-l********",
      credits: { status: "unavailable", value: null },
      tokenLookup: { status: "ok", value: 7, unit: "tokens", model: "gpt-test", message: null },
    });
    expect(result.providers[3]).toMatchObject({
      provider: "xai",
      label: "xAI",
      keyStatus: "configured",
      maskedKey: "real-l********",
      tokenLookup: { status: "ok", value: 5, model: "grok-test" },
    });
  });

  it("sanitizes credit endpoint errors", async () => {
    const apiKey = "real-looking-kie-key";
    const store = await makeStore(`KIE_API_KEY=${apiKey}\n`);

    const result = await getProviderKeyStatus({
      store,
      readKieCredits: async () => {
        throw new Error(`bad key ${apiKey}`);
      },
    });

    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(result.providers[0].credits).toMatchObject({
      status: "error",
      value: null,
      message: "bad key [redacted]",
    });
  });

  it("sanitizes token lookup endpoint errors", async () => {
    const apiKey = "real-looking-openai-key";
    const store = await makeStore(`OPENAI_API_KEY=${apiKey}\n`);

    const result = await getProviderKeyStatus({
      store,
      readOpenAiTokens: async () => {
        throw new Error(`bad key ${apiKey}`);
      },
    });

    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(result.providers[2].tokenLookup).toMatchObject({
      status: "error",
      value: null,
      message: "bad key [redacted]",
    });
  });
});

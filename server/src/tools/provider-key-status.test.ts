import { afterEach, describe, expect, it } from "vitest";
import { getProviderKeyStatus } from "./provider-key-status.js";

describe("provider key status", () => {
  const originalKey = process.env.KIE_API_KEY;

  afterEach(() => {
    if (originalKey) {
      process.env.KIE_API_KEY = originalKey;
    } else {
      delete process.env.KIE_API_KEY;
    }
  });

  it("returns missing status without calling Kie when KIE_API_KEY is not set", async () => {
    delete process.env.KIE_API_KEY;
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
});

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSecretStore, type SecretStore } from "../env-secrets.js";
import { getProviderKeyStatus } from "./provider-key-status.js";
import { setEnvSecretDef } from "./set-env-secret.js";

describe("set env secret tool", () => {
  let dir: string;
  let envPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "set-env-secret-test-"));
    envPath = join(dir, ".env");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function makeStore(envFile: string, processEnv: NodeJS.ProcessEnv = {}): Promise<SecretStore> {
    await writeFile(envPath, envFile, "utf8");
    return createSecretStore({ envPath, processEnv });
  }

  it("writes the key to .env and returns only a masked value", async () => {
    const store = await makeStore("");
    const def = setEnvSecretDef(store);
    const value = "real-looking-fal-key";

    const result = await def.handler({ key: "FAL_API_KEY", value });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).not.toContain(value);
    expect(JSON.parse(text)).toEqual({
      key: "FAL_API_KEY",
      source: "env",
      maskedKey: "real-l********",
    });
    expect(await readFile(envPath, "utf8")).toBe(`FAL_API_KEY=${value}\n`);
  });

  it("returns the full value for non-secret keys", async () => {
    const store = await makeStore("");
    const def = setEnvSecretDef(store);

    const result = await def.handler({ key: "B2_REGION", value: "us-west-004" });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({
      key: "B2_REGION",
      source: "env",
      maskedKey: "us-west-004",
    });
  });

  it("is immediately visible through provider_key_status on the same store", async () => {
    const store = await makeStore("");
    const def = setEnvSecretDef(store);

    await def.handler({ key: "DASHSCOPE_API_KEY", value: "real-looking-dashscope-key" });

    const status = await getProviderKeyStatus({ store });
    const dashscope = status.providers.find((p) => p.envKey === "DASHSCOPE_API_KEY");
    expect(dashscope).toMatchObject({
      keyStatus: "configured",
      maskedKey: "real-l********",
      source: "env",
      editable: true,
    });
  });

  it("rejects 1Password-managed keys without echoing the value", async () => {
    const store = await makeStore("", { OPENAI_API_KEY: "op-injected-value" });
    const def = setEnvSecretDef(store);
    const value = "sneaky-replacement-value";

    const result = await def.handler({ key: "OPENAI_API_KEY", value });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("1Password");
    expect(result.content[0].text).not.toContain(value);
  });

  it("rejects values with control characters as an error result", async () => {
    const store = await makeStore("");
    const def = setEnvSecretDef(store);

    const result = await def.handler({ key: "FAL_API_KEY", value: "a\nINJECTED=oops" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("control characters");
    expect(result.content[0].text).not.toContain("INJECTED");
  });

  it("rejects unmanaged keys as an error result", async () => {
    const store = await makeStore("");
    const def = setEnvSecretDef(store);

    const result = await def.handler({ key: "PATH", value: "whatever" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not a managed environment key");
  });
});

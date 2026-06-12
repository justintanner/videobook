import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "dotenv";
import { SecretWriteError, createSecretStore, type SecretStore } from "./env-secrets.js";

describe("env secrets", () => {
  let dir: string;
  let envPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "env-secrets-test-"));
    envPath = join(dir, ".env");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeStore(processEnv: NodeJS.ProcessEnv): SecretStore {
    return createSecretStore({ envPath, processEnv });
  }

  describe("source detection", () => {
    it("classifies a key loaded from .env as env", async () => {
      await writeFile(envPath, "FAL_API_KEY=fal-from-dotenv\n", "utf8");
      const processEnv: NodeJS.ProcessEnv = {};
      const store = makeStore(processEnv);

      expect(store.getSource("FAL_API_KEY")).toBe("env");
      expect(store.getValue("FAL_API_KEY")).toBe("fal-from-dotenv");
      expect(processEnv.FAL_API_KEY).toBe("fal-from-dotenv");
    });

    it("classifies a key set before .env loaded as 1password", async () => {
      await writeFile(envPath, "", "utf8");
      const store = makeStore({ OPENAI_API_KEY: "op-injected-value" });

      expect(store.getSource("OPENAI_API_KEY")).toBe("1password");
    });

    it("classifies an unset key as missing", async () => {
      await writeFile(envPath, "", "utf8");
      const store = makeStore({});

      expect(store.getSource("KIE_API_KEY")).toBe("missing");
      expect(store.getValue("KIE_API_KEY")).toBeUndefined();
    });

    it("keeps the pre-set value when a key is in both the environment and .env", async () => {
      await writeFile(envPath, "OPENAI_API_KEY=dotenv-value\n", "utf8");
      const processEnv: NodeJS.ProcessEnv = { OPENAI_API_KEY: "op-injected-value" };
      const store = makeStore(processEnv);

      expect(store.getSource("OPENAI_API_KEY")).toBe("1password");
      expect(store.getValue("OPENAI_API_KEY")).toBe("op-injected-value");
      expect(processEnv.OPENAI_API_KEY).toBe("op-injected-value");
    });

    it("works without a .env file", () => {
      const store = makeStore({ XAI_API_KEY: "op-injected-value" });

      expect(store.getSource("XAI_API_KEY")).toBe("1password");
      expect(store.getSource("KIE_API_KEY")).toBe("missing");
    });

    it("treats an unresolved op:// reference as missing", async () => {
      await writeFile(envPath, "FAL_API_KEY=op://Apicity/FAL_API_KEY/password\n", "utf8");
      const store = makeStore({});

      expect(store.getSource("FAL_API_KEY")).toBe("missing");
    });

    it("treats an empty value as missing", async () => {
      await writeFile(envPath, "B2_ARCHIVE_PREFIX=\n", "utf8");
      const store = makeStore({});

      expect(store.getSource("B2_ARCHIVE_PREFIX")).toBe("missing");
    });

    it("loads unmanaged keys from .env without overriding", async () => {
      await writeFile(envPath, "VIDEOCITY_PROJECTS_DIR=/tmp/projects\n", "utf8");
      const processEnv: NodeJS.ProcessEnv = {};
      const store = makeStore(processEnv);
      store.loadDotenv();

      expect(processEnv.VIDEOCITY_PROJECTS_DIR).toBe("/tmp/projects");
    });
  });

  describe("setEnvSecret", () => {
    it("updates an existing line while preserving every other line byte-for-byte", async () => {
      const before = "# providers\nFOO=bar\n\nFAL_API_KEY=old-value\nBAZ=qux\n";
      await writeFile(envPath, before, "utf8");
      const processEnv: NodeJS.ProcessEnv = {};
      const store = makeStore(processEnv);

      await store.setEnvSecret("FAL_API_KEY", "new-value");

      const after = await readFile(envPath, "utf8");
      expect(after).toBe("# providers\nFOO=bar\n\nFAL_API_KEY=new-value\nBAZ=qux\n");
      expect(processEnv.FAL_API_KEY).toBe("new-value");
      expect(store.getSource("FAL_API_KEY")).toBe("env");
    });

    it("appends the key when absent", async () => {
      await writeFile(envPath, "FOO=bar\n", "utf8");
      const store = makeStore({});

      await store.setEnvSecret("KIE_API_KEY", "kie-value");

      const after = await readFile(envPath, "utf8");
      expect(after).toBe("FOO=bar\nKIE_API_KEY=kie-value\n");
    });

    it("creates .env when the file does not exist", async () => {
      const store = makeStore({});

      await store.setEnvSecret("DASHSCOPE_API_KEY", "ds-value");

      const after = await readFile(envPath, "utf8");
      expect(after).toBe("DASHSCOPE_API_KEY=ds-value\n");
    });

    it("replaces the last duplicate line (last wins in dotenv)", async () => {
      await writeFile(envPath, "FAL_API_KEY=first\nFOO=bar\nFAL_API_KEY=second\n", "utf8");
      const store = makeStore({});

      await store.setEnvSecret("FAL_API_KEY", "third");

      const after = await readFile(envPath, "utf8");
      expect(after).toBe("FAL_API_KEY=first\nFOO=bar\nFAL_API_KEY=third\n");
      expect(parse(after).FAL_API_KEY).toBe("third");
    });

    it("quotes values that need it so they round-trip through dotenv", async () => {
      const store = makeStore({});
      const value = "abc#def with space";

      await store.setEnvSecret("B2_BUCKET", value);

      const after = await readFile(envPath, "utf8");
      expect(parse(after).B2_BUCKET).toBe(value);
    });

    it("flips a missing key to env and trims the value", async () => {
      await writeFile(envPath, "", "utf8");
      const processEnv: NodeJS.ProcessEnv = {};
      const store = makeStore(processEnv);
      expect(store.getSource("B2_REGION")).toBe("missing");

      await store.setEnvSecret("B2_REGION", "  us-west-004  ");

      expect(store.getSource("B2_REGION")).toBe("env");
      expect(processEnv.B2_REGION).toBe("us-west-004");
    });

    it("rejects writes to 1Password-sourced keys without leaking the value", async () => {
      await writeFile(envPath, "", "utf8");
      const store = makeStore({ OPENAI_API_KEY: "op-injected-value" });

      const attempt = store.setEnvSecret("OPENAI_API_KEY", "sneaky-new-value");

      await expect(attempt).rejects.toBeInstanceOf(SecretWriteError);
      await expect(store.setEnvSecret("OPENAI_API_KEY", "sneaky-new-value")).rejects.toThrowError(
        /1Password/,
      );
      try {
        await store.setEnvSecret("OPENAI_API_KEY", "sneaky-new-value");
      } catch (err) {
        expect((err as Error).message).not.toContain("sneaky-new-value");
      }
    });

    it("rejects empty and whitespace-only values", async () => {
      const store = makeStore({});

      await expect(store.setEnvSecret("FAL_API_KEY", "   ")).rejects.toBeInstanceOf(SecretWriteError);
    });

    it("rejects values containing newlines or control characters", async () => {
      const store = makeStore({});

      await expect(store.setEnvSecret("FAL_API_KEY", "a\nINJECTED=oops")).rejects.toBeInstanceOf(SecretWriteError);
      await expect(store.setEnvSecret("FAL_API_KEY", "a\rb")).rejects.toBeInstanceOf(SecretWriteError);
      await expect(store.setEnvSecret("FAL_API_KEY", "a\tb")).rejects.toBeInstanceOf(SecretWriteError);
    });
  });
});

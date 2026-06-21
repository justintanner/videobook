import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeHandle, readWatermarkConfig, recordHandle } from "./watermark-config.js";

describe("watermark-config store", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-watermark-config-"));
    process.env.WATERMARK_CONFIG_PATH = join(tempDir, "watermark-config.json");
  });

  afterEach(async () => {
    delete process.env.WATERMARK_CONFIG_PATH;
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns an empty config when nothing is stored", async () => {
    expect(await readWatermarkConfig()).toEqual({ savedHandle: null, recent: [] });
  });

  it("normalizes handles (strips @ and whitespace)", () => {
    expect(normalizeHandle("  @alice ")).toBe("alice");
    expect(normalizeHandle("@@bob")).toBe("@bob"); // only one leading @ is stripped
    expect(normalizeHandle("   ")).toBeNull();
    expect(normalizeHandle("@")).toBeNull();
  });

  it("unshifts most-recent-first and dedupes case-insensitively", async () => {
    await recordHandle("alice");
    await recordHandle("bob");
    await recordHandle("ALICE"); // moves alice to front, no duplicate

    const config = await readWatermarkConfig();
    expect(config.recent).toEqual(["ALICE", "bob"]);
  });

  it("pins savedHandle only when saveDefault is set", async () => {
    await recordHandle("alice", { saveDefault: true });
    await recordHandle("bob");

    const config = await readWatermarkConfig();
    expect(config.savedHandle).toBe("alice");
    expect(config.recent).toEqual(["bob", "alice"]);
  });

  it("caps recent at 8 entries", async () => {
    for (let i = 0; i < 12; i++) {
      await recordHandle(`handle${i}`);
    }
    const config = await readWatermarkConfig();
    expect(config.recent).toHaveLength(8);
    expect(config.recent[0]).toBe("handle11");
  });

  it("ignores blank handles", async () => {
    await recordHandle("   ");
    expect(await readWatermarkConfig()).toEqual({ savedHandle: null, recent: [] });
  });
});

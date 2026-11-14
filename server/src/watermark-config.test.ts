import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "videobook-engine";
import { closeEngineForTest, createEngineForTest } from "./engine.js";
import { effectiveWatermarkProfile, saveWatermarkProfile, normalizeHandle, readWatermarkConfig, recordHandle, setAuthenticatedHandle } from "./watermark-config.js";

import { LIGHTNING_WATERMARK_PROFILE } from "./lightning-defaults.js";

describe("watermark-config store", () => {
  let tempDir: string;
  let engine: Engine;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-watermark-config-"));
    engine = createEngineForTest(tempDir);
  });

  afterEach(async () => {
    closeEngineForTest(tempDir, engine);
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  function readConfig() {
    return readWatermarkConfig(engine);
  }

  function recordTestHandle(
    handle: string,
    opts: { saveDefault?: boolean } = {},
  ) {
    return recordHandle(handle, opts, engine);
  }

  function setTestAuthenticatedHandle(handle: string | null) {
    return setAuthenticatedHandle(handle, engine);
  }


  it("upgrades a stored old-default TikTok look without rewriting its settings", async () => {
    const profile = { ...LIGHTNING_WATERMARK_PROFILE, handlePlacement: "center", handle: "creator", qrOpacity: 0.8 };
    expect(engine.settings.set("application.watermark.tiktok.v1", { profile }).ok).toBe(true);
    const config = await readWatermarkConfig(engine, "tiktok");
    expect(effectiveWatermarkProfile(config, "tiktok")).toMatchObject({ handlePlacement: "above-title", handle: "creator", qrOpacity: 0.8 });
    expect((await readWatermarkConfig(engine, "tiktok")).profile).toEqual(profile);
    expect(effectiveWatermarkProfile(config, "x").handlePlacement).toBe("center");
    await saveWatermarkProfile({ handle: "newname" }, "tiktok", engine);
    expect(effectiveWatermarkProfile(await readWatermarkConfig(engine, "tiktok"), "tiktok")).toMatchObject({ handlePlacement: "above-title", handle: "newname" });
  });

  it.each([
    { handleVerticalPercent: 30 }, { handlePaddingX: 18 }, { handleOpacity: 0.8 },
    { handleEndSeconds: null }, { includePlatformIcon: false }, { scale: 1.2 },
    { handlePlacement: "above-qr" as const },
  ])("preserves customized legacy TikTok handles: %j", async (custom) => {
    const profile = { ...LIGHTNING_WATERMARK_PROFILE, handlePlacement: "center", ...custom };
    expect(engine.settings.set("application.watermark.tiktok.v1", { profile }).ok).toBe(true);
    expect(effectiveWatermarkProfile(await readWatermarkConfig(engine, "tiktok"), "tiktok")).toMatchObject(profile);
  });

  it("keeps a newly saved explicit center placement, even at the old defaults", async () => {
    await saveWatermarkProfile({ ...LIGHTNING_WATERMARK_PROFILE, handlePlacement: "center" }, "tiktok", engine);
    const config = await readWatermarkConfig(engine, "tiktok");
    expect(config.profile?.handleLayoutVersion).toBe(2);
    expect(effectiveWatermarkProfile(config, "tiktok").handlePlacement).toBe("center");
  });

  it("returns an empty config when nothing is stored", async () => {
    expect(await readConfig()).toEqual({ savedHandle: null, recent: [], authenticatedHandle: null });
  });

  it("keeps TikTok preferences separate from existing X preferences and authentication", async () => {
    await recordTestHandle("x_alias", { saveDefault: true });
    await setTestAuthenticatedHandle("signed_in_x");
    expect(await readWatermarkConfig(engine, "tiktok")).toEqual({
      savedHandle: null, recent: [], authenticatedHandle: null,
    });
    await recordHandle("  @creator.name  ", { platform: "tiktok", saveDefault: true }, engine);
    await recordHandle("CREATOR.NAME", { platform: "tiktok" }, engine);
    expect(await readWatermarkConfig(engine, "tiktok")).toEqual({
      savedHandle: "creator.name", recent: ["CREATOR.NAME"], authenticatedHandle: null,
    });
    expect(await readConfig()).toEqual({
      savedHandle: "x_alias", recent: ["x_alias"], authenticatedHandle: "signed_in_x",
    });
  });

  it("normalizes handles (strips @ and whitespace)", () => {
    expect(normalizeHandle("  @alice ")).toBe("alice");
    expect(normalizeHandle("@@bob")).toBe("@bob"); // only one leading @ is stripped
    expect(normalizeHandle("   ")).toBeNull();
    expect(normalizeHandle("@")).toBeNull();
  });

  it("unshifts most-recent-first and dedupes case-insensitively", async () => {
    await recordTestHandle("alice");
    await recordTestHandle("bob");
    await recordTestHandle("ALICE"); // moves alice to front, no duplicate

    const config = await readConfig();
    expect(config.recent).toEqual(["ALICE", "bob"]);
  });

  it("pins savedHandle only when saveDefault is set", async () => {
    await recordTestHandle("alice", { saveDefault: true });
    await recordTestHandle("bob");

    const config = await readConfig();
    expect(config.savedHandle).toBe("alice");
    expect(config.recent).toEqual(["bob", "alice"]);
  });

  it("caps recent at 8 entries", async () => {
    for (let i = 0; i < 12; i++) {
      await recordTestHandle(`handle${i}`);
    }
    const config = await readConfig();
    expect(config.recent).toHaveLength(8);
    expect(config.recent[0]).toBe("handle11");
  });

  it("ignores blank handles", async () => {
    await recordTestHandle("   ");
    expect(await readConfig()).toEqual({ savedHandle: null, recent: [], authenticatedHandle: null });
  });

  it("caches and clears the authenticated handle (read-through fallback)", async () => {
    expect((await readConfig()).authenticatedHandle).toBeNull();

    await setTestAuthenticatedHandle("liveuser");
    expect((await readConfig()).authenticatedHandle).toBe("liveuser");

    // setAuthenticatedHandle is idempotent when the value is unchanged.
    const before = await readConfig();
    const after = await setTestAuthenticatedHandle("liveuser");
    expect(after).toEqual(before);

    // Normalizes incoming handles (strips @ / whitespace).
    await setTestAuthenticatedHandle("  @newhandle  ");
    expect((await readConfig()).authenticatedHandle).toBe("newhandle");

    // Preserves savedHandle + recent across updates.
    await recordTestHandle("alice", { saveDefault: true });
    await setTestAuthenticatedHandle("someone");
    const config = await readConfig();
    expect(config.savedHandle).toBe("alice");
    expect(config.recent).toEqual(["alice"]);
    expect(config.authenticatedHandle).toBe("someone");

    // null clears the cache.
    await setTestAuthenticatedHandle(null);
    expect((await readConfig()).authenticatedHandle).toBeNull();
  });
});

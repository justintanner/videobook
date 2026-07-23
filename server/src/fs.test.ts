import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  fs as defaultFs,
  createFsForTest,
  environmentValue,
} from "./fs.js";

describe("fs module", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("default fs export exists and has expected methods", () => {
    expect(defaultFs).toBeDefined();
    expect(typeof defaultFs.createProject).toBe("function");
    expect(typeof defaultFs.listAssets).toBe("function");
  });

  it("uses defaults for missing and blank environment values", () => {
    expect(environmentValue(undefined, "/fallback")).toBe("/fallback");
    expect(environmentValue("", "/fallback")).toBe("/fallback");
    expect(environmentValue("   ", "/fallback")).toBe("/fallback");
    expect(environmentValue(" /custom ", "/fallback")).toBe("/custom");
  });

  it("createFsForTest returns a VideocityFs instance", () => {
    const testFs = createFsForTest(tempDir);
    expect(testFs).toBeDefined();
    expect(typeof testFs.createProject).toBe("function");
    expect(typeof testFs.listAssets).toBe("function");
    expect(typeof testFs.createAsset).toBe("function");
    expect(typeof testFs.getManifest).toBe("function");
    expect(typeof testFs.writeFile).toBe("function");
    expect(typeof testFs.readFile).toBe("function");
    expect(typeof testFs.deleteFile).toBe("function");
  });

  it("createFsForTest instance can create a project", async () => {
    const testFs = createFsForTest(tempDir);
    const result = await testFs.createProject("my-test");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.slug).toBe("my-test");
    }
  });
});

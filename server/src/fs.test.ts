import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  fs as defaultFs,
  createEngineForTest,
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
    expect(typeof defaultFs.projects.create).toBe("function");
    expect(typeof defaultFs.artifacts.list).toBe("function");
  });

  it("uses defaults for missing and blank environment values", () => {
    expect(environmentValue(undefined, "/fallback")).toBe("/fallback");
    expect(environmentValue("", "/fallback")).toBe("/fallback");
    expect(environmentValue("   ", "/fallback")).toBe("/fallback");
    expect(environmentValue(" /custom ", "/fallback")).toBe("/custom");
  });

  it("createEngineForTest returns an Engine instance", () => {
    const testFs = createEngineForTest(tempDir);
    expect(testFs).toBeDefined();
    expect(typeof testFs.projects.create).toBe("function");
    expect(typeof testFs.artifacts.list).toBe("function");
    expect(typeof testFs.artifacts.create).toBe("function");
    expect(typeof testFs.files.manifest).toBe("function");
    expect(typeof testFs.files.write).toBe("function");
    expect(typeof testFs.files.read).toBe("function");
    expect(typeof testFs.files.delete).toBe("function");
  });

  it("createEngineForTest instance can create a project", async () => {
    const testFs = createEngineForTest(tempDir);
    const result = await testFs.projects.create("my-test");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.slug).toBe("my-test");
    }
  });
});

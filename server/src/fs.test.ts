import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withBookContext } from "./book-context.js";
import {
  fs as defaultFs,
  closeEngineForTest,
  createEngineForTest,
  environmentValue,
} from "./fs.js";

describe("fs module", () => {
  let tempDir: string;
  let testEngine: ReturnType<typeof createEngineForTest> | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
  });

  afterEach(async () => {
    if (testEngine) {
      closeEngineForTest(tempDir, testEngine);
      testEngine = undefined;
    }
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  function currentTestEngine() {
    testEngine ??= createEngineForTest(tempDir);
    return testEngine;
  }

  it("requires a book context for the default fs", () => {
    expect(() => defaultFs.artifacts).toThrow(
      "A book context is required for this operation",
    );
  });

  it("uses defaults for missing and blank environment values", () => {
    expect(environmentValue(undefined, "/fallback")).toBe("/fallback");
    expect(environmentValue("", "/fallback")).toBe("/fallback");
    expect(environmentValue("   ", "/fallback")).toBe("/fallback");
    expect(environmentValue(" /custom ", "/fallback")).toBe("/custom");
  });

  it("createEngineForTest returns an Engine instance", () => {
    const testFs = currentTestEngine();
    expect(testFs).toBeDefined();
    expect(testFs.book.get().name).toBe("test-book");
    expect(typeof testFs.artifacts.list).toBe("function");
    expect(typeof testFs.artifacts.create).toBe("function");
    expect(typeof testFs.files.manifest).toBe("function");
    expect(typeof testFs.files.write).toBe("function");
    expect(typeof testFs.files.read).toBe("function");
    expect(typeof testFs.files.delete).toBe("function");
  });

  it("routes the default fs through the active book context", async () => {
    const testFs = currentTestEngine();
    await withBookContext(
      { bookId: testFs.book.get().bookId, engine: testFs },
      async () => {
        expect(defaultFs.artifacts).toBe(testFs.artifacts);
        expect(defaultFs.book.get()).toEqual(testFs.book.get());
      },
    );
  });

  it("createEngineForTest instance can create an artifact", async () => {
    const testFs = currentTestEngine();
    const result = await testFs.artifacts.create("video", "my-test");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("video");
    }
  });
});

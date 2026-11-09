import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeBookEngine, currentBookContext, scopedBookEngine, withBookContext } from "./book-context.js";
import { createEngineForTest } from "./engine.js";

describe("book context", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-book-context-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("keeps the enclosing concrete engine when a nested context passes the scoped proxy", async () => {
    const engine = createEngineForTest(rootDir);
    await engine.ready;
    const bookId = engine.book.get().bookId;

    const nested = await withBookContext({ bookId, engine, operation: "outer" }, () =>
      withBookContext({ bookId, engine: scopedBookEngine, operation: "inner" }, async () => ({
        active: activeBookEngine(),
        bookId: scopedBookEngine.book.get().bookId,
      })));

    expect(nested.active).toBe(engine);
    expect(nested.bookId).toBe(bookId);
  });

  it("keeps omitted job, cell, and notebook attribution and lets an explicit cell replace it", async () => {
    const engine = createEngineForTest(rootDir);
    await engine.ready;
    const bookId = engine.book.get().bookId;
    const inherited = await withBookContext({
      bookId, engine, notebookId: "nb", cellId: "cell", jobId: "job", runId: "run",
    }, () => withBookContext({ bookId, engine, operation: "inner" }, async () => currentBookContext()));
    expect(inherited).toMatchObject({ notebookId: "nb", cellId: "cell", jobId: "job", runId: "run", operation: "inner" });

    const replaced = await withBookContext({
      bookId, engine, notebookId: "nb", cellId: "cell", jobId: "job", runId: "run",
    }, () => withBookContext({ bookId, engine, cellId: "other" }, async () => currentBookContext()));
    expect(replaced).toMatchObject({ notebookId: "nb", cellId: "other", jobId: "job", runId: "run" });

    const bare = await withBookContext({ bookId, engine }, async () => currentBookContext());
    expect(bare?.notebookId).toBeUndefined();
    expect(bare?.cellId).toBeUndefined();
    expect(bare?.jobId).toBeUndefined();
  });

  it("rejects the scoped proxy when no book context encloses it", async () => {
    await expect(withBookContext(
      { bookId: "missing", engine: scopedBookEngine },
      async () => undefined,
    )).rejects.toThrow("A book context is required for this operation");
  });
});

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BookManager } from "./book-manager.js";

describe("book manager create", () => {
  let root: string | undefined;
  let books: BookManager | undefined;

  afterEach(async () => {
    await books?.close();
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it("publishes a new book directory under its id", async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-books-"));
    const libraryDir = join(root, "books");
    books = new BookManager({ libraryDir });
    const created = await books.create("pack-install");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const entries = await readdir(libraryDir);
    expect(entries).toContain(created.value.bookId);
    expect(entries.some((name) => name.startsWith(".creating-"))).toBe(false);
  });
});

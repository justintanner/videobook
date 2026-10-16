import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine } from "videobook-engine";
import { BookManager } from "../book-manager.js";
import { preparedToolsFor } from "./index.js";

describe("prepared MCP tools", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("builds tool definitions once per engine and book manager", async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-prepared-tools-"));
    const engine = createEngine({ durableWrites: false, rootDir: join(root, "engine"), initialBookName: "prepared" });
    const books = new BookManager({ libraryDir: join(root, "books") });
    const otherBooks = new BookManager({ libraryDir: join(root, "other-books") });

    const first = preparedToolsFor(engine, books);
    expect(preparedToolsFor(engine, books)).toBe(first);
    expect(preparedToolsFor(engine, otherBooks)).not.toBe(first);
    expect(first.map((tool) => tool.def.name)).toEqual(preparedToolsFor(engine, otherBooks).map((tool) => tool.def.name));

    engine.close();
    await books.close();
    await otherBooks.close();
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scopedBookEngine, withBookContext } from "../../server/src/book-context.js";
import { BookManager } from "../../server/src/book-manager.js";
import { videobookDomainDefs } from "../../server/src/tools/videobook-domain.js";
import type { ToolDef } from "../../server/src/tools/tool-def.js";
import { asNotebook } from "../../src/videobook/workspace-responses";

type Invoke = (name: string, args: Record<string, unknown>) => Promise<unknown>;

const sunburst = "image:gpt-image-2-6-sunburst";
const nano = "image:nano-banana-2-1";
const remembered = {
  [sunburst]: "wavespeed",
  [nano]: "kie",
};

function resultJson(result: Awaited<ReturnType<ToolDef["handler"]>>): unknown {
  expect(result.isError, result.content[0]?.text).toBeUndefined();
  return JSON.parse(result.content[0]!.text) as unknown;
}

function imageCell(column: number, model: string): Record<string, unknown> {
  return {
    type: "generate_image",
    slot: { row: 0, column },
    prompt: "a red kite",
    provider: model.split(":")[0],
    model,
    operation: "text_to_image",
    tool: "generate_image",
  };
}

describe("generation provider memory", () => {
  let rootDir: string;
  let books: BookManager;
  let bookId: string;
  let invoke: Invoke;

  function bind(manager: BookManager, id: string): void {
    const byName = new Map(videobookDomainDefs(scopedBookEngine, manager).map((def) => [def.name, def]));
    invoke = async (name, args) => {
      const managed = manager.get(id);
      if (!managed.ok) throw new Error(managed.error.message);
      return resultJson(await withBookContext(
        { bookId: id, engine: managed.value.engine },
        () => byName.get(name)!.handler({ book_id: id, ...args }),
      ));
    };
  }

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-provider-memory-"));
    books = new BookManager({ libraryDir: join(rootDir, "books"), objectPrefix: "test-objects" });
    await books.ready();
    const byName = new Map(videobookDomainDefs(scopedBookEngine, books).map((def) => [def.name, def]));
    const created = resultJson(await byName.get("create_book")!.handler({ name: "provider-memory" })) as { bookId: string };
    bookId = created.bookId;
    bind(books, bookId);
  });

  afterEach(async () => {
    await books.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function notebookIds(): Promise<string[]> {
    const notebooks = await invoke("list_notebooks", {}) as Array<{ id: string }>;
    return notebooks.map((notebook) => notebook.id);
  }

  async function memoryOf(id: string): Promise<unknown> {
    const document = await invoke("get_notebook", { notebook_id: id }) as { generation_provider_memory: unknown };
    expect(asNotebook(document)?.generationProviderMemory).toEqual(document.generation_provider_memory);
    return document.generation_provider_memory;
  }

  it("stores a provider per family for every notebook and keeps it across a restart", async () => {
    const [main] = await notebookIds();
    const second = await invoke("create_notebook", { name: "Other" }) as { id: string };
    expect(await invoke("remember_generation_provider", { family_id: sunburst, provider: "wavespeed" }))
      .toEqual({ generation_provider_memory: { [sunburst]: "wavespeed" } });
    expect(await invoke("remember_generation_provider", { family_id: nano, provider: "kie" }))
      .toEqual({ generation_provider_memory: remembered });

    for (const id of [main, second.id]) expect(await memoryOf(id!)).toEqual(remembered);

    const cell = await invoke("create_notebook_cell", {
      notebook_id: main,
      cell: imageCell(0, "wavespeed:openai/gpt-image-2.6-sunburst/text-to-image"),
    }) as { id: string };
    await invoke("update_notebook_cell", {
      notebook_id: main,
      cell_id: cell.id,
      cell: { model: "kie:nano-banana-2-1", provider: "kie" },
    });
    expect(await memoryOf(main!)).toEqual(remembered);

    const managed = books.get(bookId);
    if (!managed.ok) throw new Error(managed.error.message);
    const rejected = await withBookContext(
      { bookId, engine: managed.value.engine },
      () => videobookDomainDefs(scopedBookEngine, books)
        .find((def) => def.name === "remember_generation_provider")!
        .handler({ book_id: bookId, family_id: sunburst, provider: "fal:openai/gpt-image-2.6/sunburst/text-to-image" }),
    );
    expect(rejected.isError).toBe(true);
    expect(await memoryOf(main!)).toEqual(remembered);

    await books.close();
    books = new BookManager({ libraryDir: join(rootDir, "books"), objectPrefix: "test-objects" });
    await books.ready();
    bind(books, bookId);
    for (const id of [main, second.id]) expect(await memoryOf(id!)).toEqual(remembered);
  });
});

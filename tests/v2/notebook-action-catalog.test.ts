import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BookManager } from "../../server/src/book-manager.js";
import { scopedBookEngine, withBookContext } from "../../server/src/book-context.js";
import {
  DEFAULT_ANIMATION_TOOL,
  listNotebookActions,
  validateCellConfiguration,
} from "../../server/src/notebook-action-catalog.js";
import { videobookDomainDefs } from "../../server/src/tools/videobook-domain.js";
import type { ToolDef } from "../../server/src/tools/tool-def.js";

function resultJson(result: Awaited<ReturnType<ToolDef["handler"]>>): unknown {
  expect(result.isError, result.content[0]?.text).toBeUndefined();
  return JSON.parse(result.content[0]!.text) as unknown;
}

describe("notebook action catalog", () => {
  let rootDir: string;
  let books: BookManager;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-catalog-"));
    books = new BookManager({ libraryDir: join(rootDir, "books"), objectPrefix: "test-objects" });
    await books.ready();
  });

  afterEach(async () => {
    await books.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("exposes deterministic analysis and seedance defaults", () => {
    const actions = listNotebookActions();
    const ids = actions.map((action) => action.id);
    expect(ids).toEqual([...ids].sort((left, right) => left.localeCompare(right)));
    const analysis = actions.find((action) => action.operation === "analyze_source");
    expect(analysis).toMatchObject({
      provider: "kie",
      model: "gemini-3.5-flash",
      tool: "kie_gemini_analysis",
    });
    expect(actions.some((action) => action.tool === DEFAULT_ANIMATION_TOOL)).toBe(true);
    expect(actions.some((action) => action.tool === "ffmpeg")).toBe(true);
  });

  it("rejects invalid tools and returns 14-column raw rows via MCP", async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books);
    const byName = new Map(defs.map((def) => [def.name, def]));
    const created = resultJson(await byName.get("create_book")!.handler({ slug: "catalog" })) as {
      bookId: string
    };
    const managed = books.get(created.bookId);
    expect(managed.ok).toBe(true);
    if (!managed.ok) return;

    const invoke = async (name: string, args: Record<string, unknown>) => {
      const def = byName.get(name);
      if (!def) throw new Error(`Missing ${name}`);
      return await withBookContext(
        { bookId: created.bookId, engine: managed.value.engine },
        () => def.handler({ book_id: created.bookId, ...args }),
      );
    };

    const notebooks = resultJson(await invoke("list_notebooks", {})) as Array<{ id: string }>;
    const notebookId = notebooks[0]!.id;
    const analysis = resultJson(await invoke("create_notebook_cell", {
      notebook_id: notebookId,
      cell: {
        type: "analyze",
        title: "Analyze",
        slot: { row: 0, column: 0 },
        prompt: "Segment the source",
        provider: "kie",
        model: "gemini-3.5-flash",
        operation: "analyze_source",
        tool: "kie_gemini_analysis",
      },
    })) as { id: string };

    const catalog = resultJson(await invoke("list_notebook_actions", {
      cell_type: "analyze",
    })) as { actions: Array<{ operation: string; model: string | null }> };
    expect(catalog.actions.some((action) => action.operation === "analyze_source")).toBe(true);

    const details = resultJson(await invoke("get_notebook_cell_details", {
      notebook_id: notebookId,
      cell_id: analysis.id,
    })) as {
      rawRow: Array<{ column: string }>
      validation: { ok: boolean }
      action: { tool: string | null }
    };
    expect(details.rawRow.map((row) => row.column)).toEqual([
      "notebook_id",
      "cell_id",
      "type",
      "title",
      "grid_row",
      "grid_column",
      "entity_id",
      "prompt",
      "provider",
      "model",
      "operation",
      "tool",
      "inputs_json",
      "output_artifact_id",
    ]);
    expect(details.validation.ok).toBe(true);
    expect(details.action.tool).toBe("kie_gemini_analysis");

    const invalid = await invoke("update_notebook_cell", {
      notebook_id: notebookId,
      cell_id: analysis.id,
      cell: { tool: "not-a-real-tool" },
    });
    expect(invalid.isError).toBe(true);

    const valid = validateCellConfiguration({
      id: analysis.id,
      type: "analyze",
      title: "Analyze",
      slot: { row: 0, column: 0 },
      operation: "analyze_source",
      tool: "kie_gemini_analysis",
      provider: "kie",
    }, {
      id: notebookId,
      name: "Main",
      cells: [],
      edges: [],
      createdAt: new Date().toISOString(),
    });
    expect(valid.ok).toBe(true);
  });
});

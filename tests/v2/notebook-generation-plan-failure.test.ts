import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BookManager } from "../../server/src/book-manager.js";
import { withBookContext } from "../../server/src/book-context.js";
import { registerGenerateMediaJob } from "../../server/src/jobs/generate-media.js";
import { registerRunNotebookJob } from "../../server/src/jobs/run-notebook.js";
import { setEngineRoot, stopBookQueue } from "../../server/src/queue.js";
import { videobookDomainDefs } from "../../server/src/tools/videobook-domain.js";
import { testBudget } from "../../server/src/test-budget.js";

describe("generation plan after an asynchronous provider failure", () => {
  let rootDir: string;
  let books: BookManager;
  let previousKieKey: string | undefined;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-plan-provider-failure-"));
    books = new BookManager({
      libraryDir: join(rootDir, "books"),
      objectPrefix: "test-objects",
    });
    await books.ready();
    previousKieKey = process.env.KIE_API_KEY;
    process.env.KIE_API_KEY = "test-plan-provider-failure";
  });

  afterEach(async () => {
    if (previousKieKey === undefined) delete process.env.KIE_API_KEY;
    else process.env.KIE_API_KEY = previousKieKey;
    await books.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("reports the claimed plan failed with the provider error", async () => {
    const created = await books.create("plan-provider-failure");
    if (!created.ok) throw new Error(created.error.message);
    const managed = books.get(created.value.bookId);
    if (!managed.ok) throw new Error(managed.error.message);
    const engine = managed.value.engine;
    const bookId = created.value.bookId;
    const notebookId = engine.notebooks.list()[0]!.id;
    const defs = new Map(videobookDomainDefs(engine, books).map((def) => [def.name, def]));
    const invoke = async (name: string, args: Record<string, unknown>) => {
      const result = await withBookContext(
        { bookId, engine },
        () => defs.get(name)!.handler({ book_id: bookId, notebook_id: notebookId, ...args }),
      );
      expect(result.isError, result.content[0]?.text).toBeUndefined();
      return JSON.parse(result.content[0]!.text) as unknown;
    };
    registerRunNotebookJob(engine);
    registerGenerateMediaJob(engine);
    await setEngineRoot(rootDir, engine);
    try {
      const cell = await invoke("create_notebook_cell", {
        cell: {
          type: "generate_image",
          label: "Moonlit garden",
          slot: { row: 0, column: 0 },
          prompt: "A moonlit garden",
          model: "kie:gpt-image-2-5-sunburst-text-to-image",
        },
      }) as { id: string };
      const plan = await invoke("plan_notebook_generation", {
        cell_id: cell.id,
        source_surface: "ui",
        actor: "tester",
        timeline_start_frame: 0,
      }) as { planId: string };
      const queued = await invoke("run_notebook_cell", {
        cell_id: cell.id,
        plan,
      }) as { run_id: string; output_cell_id: string };

      await expect.poll(
        () => engine.jobs.queue.list({ type: "run_notebook" })
          .find((job) => job.payload.resume === true)?.state,
        { timeout: testBudget(30_000) },
      ).toBe("failed");

      expect(engine.jobs.queue.list({ type: "generate_media" })).toEqual([
        expect.objectContaining({
          state: "failed",
          error: expect.objectContaining({
            message: expect.stringContaining("KIE_API_KEY is a placeholder"),
          }),
        }),
      ]);
      const notebook = engine.notebooks.read(notebookId);
      if (!notebook.ok) throw new Error(notebook.error.message);
      const output = notebook.value.execution?.[queued.output_cell_id];
      expect(output).toMatchObject({
        status: "error",
        runId: queued.run_id,
        error: expect.stringContaining("Kie failed: KIE_API_KEY is a placeholder"),
      });
      expect(await invoke("list_notebook_generation_plans", {})).toEqual([
        expect.objectContaining({
          planId: plan.planId,
          status: "failed",
          error: output?.error,
        }),
      ]);
    } finally {
      await stopBookQueue(bookId);
    }
  }, testBudget(60_000));
});

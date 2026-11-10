import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FalEstimator } from "@apicity/cost";
import { BookManager } from "../../server/src/book-manager.js";
import { scopedBookEngine, withBookContext } from "../../server/src/book-context.js";
import { installFalDynamicEstimator } from "../../server/src/media/cost.js";
import { videobookDomainDefs } from "../../server/src/tools/videobook-domain.js";
import type { ToolDef } from "../../server/src/tools/tool-def.js";

const LOWER_BOUND_WARNING = "fal 'minimax/h3-max/extend-video': prices the requested seconds only; reference tokens beyond the included 4,096 ($0.02 per 1,000) are not counted, so this estimate is a lower bound";

function resultText(result: Awaited<ReturnType<ToolDef["handler"]>>): string {
  return result.content[0]?.text ?? "";
}

describe("MiniMax H3 Max extend video quote", () => {
  let rootDir: string;
  let books: BookManager;
  let restores: Array<() => void>;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-h3-extend-"));
    books = new BookManager({
      libraryDir: join(rootDir, "books"),
      objectPrefix: "test-objects",
    });
    await books.ready();
    restores = [];
  });

  afterEach(async () => {
    for (const restore of restores.splice(0).reverse()) restore();
    await books.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  async function extendCell(name: string, settings: Record<string, unknown>) {
    const defs = videobookDomainDefs(scopedBookEngine, books);
    const byName = new Map(defs.map((def) => [def.name, def]));
    const created = JSON.parse(resultText(await byName.get("create_book")!.handler({
      name,
    }))) as { bookId: string };
    const managed = books.get(created.bookId);
    if (!managed.ok) throw new Error(managed.error.message);
    const engine = managed.value.engine;
    const invoke = (name: string, args: Record<string, unknown>) => {
      const def = byName.get(name);
      if (!def) throw new Error(`Missing ${name}`);
      return withBookContext(
        { bookId: created.bookId, engine },
        () => def.handler({ book_id: created.bookId, ...args }),
      );
    };
    const notebookId = (JSON.parse(resultText(await invoke("list_notebooks", {}))) as Array<{
      id: string;
    }>)[0]!.id;
    const source = await engine.artifacts.create("video", "source-clip");
    if (!source.ok) throw new Error(source.error.message);
    await engine.metadata.artifacts.write(source.value.artifactId, "original", { duration: 6 });
    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    const video = engine.notebooks.createCell({
      type: "video",
      slot: { row: 0, column: 0 },
      outputArtifactId: source.value.artifactId,
    });
    const generation = engine.notebooks.createCell({
      type: "generate_video",
      slot: { row: 1, column: 0 },
      prompt: "Keep walking down the street.",
      provider: "fal",
      model: "fal:minimax/h3-max/extend-video",
      operation: "extend_video",
      tool: "generate_video",
      inputs: { generationSettings: settings },
    });
    const written = await engine.notebooks.write({
      ...notebook.value,
      cells: [...notebook.value.cells, video, generation],
      edges: [engine.notebooks.createEdge({
        source: video.id,
        target: generation.id,
        targetInput: "video",
      })],
    });
    if (!written.ok) throw new Error(written.error.message);
    return {
      preview: () => invoke("preview_notebook_generation", { notebook_id: notebookId, cell_id: generation.id }),
      plan: () => invoke("plan_notebook_generation", { notebook_id: notebookId, cell_id: generation.id, timeline_start_frame: 0 }),
      runPlans: () => Promise.all([
        invoke("plan_notebook_run", { notebook_id: notebookId, source_surface: "ui", actor: "user" }),
        invoke("plan_notebook_subgraph", { notebook_id: notebookId, cell_id: generation.id, source_surface: "ui", actor: "user" }),
      ]),
    };
  }

  function install(estimator: FalEstimator | null): void {
    restores.push(installFalDynamicEstimator(estimator));
  }

  it.each([
    [5, 1.6],
    [15, 4.8],
  ])("plans a %ss 2K extend at least its per-second floor of $%s, with fal's admin estimator or without, and asks fal nothing", async (duration, usd) => {
    const pricingCalls: unknown[] = [];
    for (const estimator of [
      async (request: Parameters<FalEstimator>[0]) => {
        pricingCalls.push(request);
        return { total_cost: 0.32, currency: "USD" };
      },
      null,
    ]) {
      install(estimator);
      const cell = await extendCell(`h3-extend-${estimator ? "live" : "withheld"}`, { duration, resolution: "2K" });

      const preview = await cell.preview();
      expect(preview.isError, resultText(preview)).toBeFalsy();
      const previewed = JSON.parse(resultText(preview)) as { payload: { input: Record<string, unknown> }; estimate: { usd: number; warnings: string[] } };
      expect(previewed.payload.input).toMatchObject({ duration, resolution: "2K" });
      expect(previewed.estimate.usd).toBeCloseTo(usd, 6);
      expect(previewed.estimate.warnings).toEqual([LOWER_BOUND_WARNING]);

      const plan = await cell.plan();
      expect(plan.isError, resultText(plan)).toBeFalsy();
      const planned = JSON.parse(resultText(plan)) as {
        stages: Array<Record<string, unknown>>;
        confirmation: { reason: string };
      };
      expect(planned.stages).toEqual([expect.objectContaining({
        kind: "queued",
        provider: "fal",
        estimatedCostUsd: expect.closeTo(usd, 6),
        estimateLowerBound: true,
      })]);
      expect(planned.stages[0]).not.toHaveProperty("estimateHistorical");
      expect(planned.confirmation.reason).toBe("This plan can incur provider spend. The quoted figure is a lower bound, so the bill can be higher.");

      const [run, subgraph] = await cell.runPlans();
      for (const [runPlan, scope] of [[run!, "This run"], [subgraph!, "This selected run"]] as const) {
        expect(runPlan.isError, resultText(runPlan)).toBeFalsy();
        expect(JSON.parse(resultText(runPlan))).toMatchObject({
          stages: expect.arrayContaining([expect.objectContaining({
            estimatedCostUsd: expect.closeTo(usd, 6),
            estimateLowerBound: true,
          })]),
          confirmation: {
            reason: `${scope} has an estimated provider cost of at least $${usd.toFixed(4)}; actual spend may differ`,
          },
        });
      }
    }
    expect(pricingCalls).toEqual([]);
  });
});

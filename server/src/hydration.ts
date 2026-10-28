import { trendingScheduler } from "./trending/scheduler.js";
import type { BookManager, ManagedBook } from "./book-manager.js";
import { startPostMetricsScheduler } from "./posts/post-metrics.js";
import { queue } from "./queue.js";
import { loadAndArmAll } from "./scheduled-posts.js";

export type HydrationPhase = "open" | "import" | "reconcile";

export interface HydrationStep<T> {
  phase: HydrationPhase;
  label: string;
  run: () => Promise<T> | T;
}

export type HydrationStepRunner = <T>(step: HydrationStep<T>) => Promise<T>;

export interface HydrationOptions {
  devFixtures: boolean;
  startQueue?: boolean;
  startPostMetrics?: boolean;
  startTrending?: boolean;
  runStep?: HydrationStepRunner;
}

const runDirectly: HydrationStepRunner = async (step) => await step.run();

function openBooks(books: BookManager): ManagedBook[] {
  return books.list().flatMap((book) => {
    const selected = books.get(book.bookId);
    return selected.ok ? [selected.value] : [];
  });
}

function bookTag(book: ManagedBook): string {
  return `${book.name} [${book.bookId.slice(0, 8)}]`;
}

async function loadReconcilers(run: HydrationStepRunner) {
  const imageSubjects = await run({ phase: "import", label: "jobs/image-subjects (hydrate)", run: () => import("./jobs/image-subjects.js") });
  const runNotebook = await run({ phase: "import", label: "jobs/run-notebook (hydrate)", run: () => import("./jobs/run-notebook.js") });
  return { imageSubjects, runNotebook };
}

type Reconcilers = Awaited<ReturnType<typeof loadReconcilers>>;

async function ensureDevFixtures(books: BookManager, run: HydrationStepRunner): Promise<void> {
  const dancing = await run({ phase: "import", label: "dancing-workflow (fixtures)", run: () => import("./dancing-workflow.js") });
  await run({ phase: "reconcile", label: "ensureDancingWorkflow()", run: () => dancing.ensureDancingWorkflow(books) });
}

async function reconcileBeforeQueue(books: BookManager, run: HydrationStepRunner, reconcilers: Reconcilers): Promise<void> {
  const { imageSubjects, runNotebook } = reconcilers;
  for (const book of openBooks(books)) {
    const tag = bookTag(book);
    await run({ phase: "reconcile", label: `${tag} jobs.queue.reap()`, run: () => book.engine.jobs.queue.reap() });
    await run({ phase: "reconcile", label: `${tag} reconcileImageSubjectJobFailures`, run: () => imageSubjects.reconcileImageSubjectJobFailures(book.engine, book.bookId) });
    await run({ phase: "reconcile", label: `${tag} abortLeasedNotebookRunsOnStartup`, run: () => runNotebook.abortLeasedNotebookRunsOnStartup(book.engine) });
    await run({ phase: "reconcile", label: `${tag} reconcileGenerationMediaOutputs`, run: () => runNotebook.reconcileGenerationMediaOutputs(book.engine) });
    await run({ phase: "reconcile", label: `${tag} reconcileQueuedNotebookCells`, run: () => runNotebook.reconcileQueuedNotebookCells(book.engine) });
  }
}

async function reconcileAfterQueue(books: BookManager, run: HydrationStepRunner, reconcilers: Reconcilers): Promise<void> {
  for (const book of openBooks(books)) {
    await run({
      phase: "reconcile",
      label: `${bookTag(book)} reconcileAwaitingNotebookOutputs`,
      run: () => reconcilers.runNotebook.reconcileAwaitingNotebookOutputs(book.engine, book.bookId),
    });
  }
}

export async function hydrateLibrary(books: BookManager, options: HydrationOptions): Promise<void> {
  const run = options.runStep ?? runDirectly;
  await run({ phase: "open", label: "bookManager.ready()", run: () => books.ready() });
  if (options.devFixtures) await ensureDevFixtures(books, run);
  const reconcilers = await loadReconcilers(run);
  await reconcileBeforeQueue(books, run, reconcilers);
  if (options.startQueue !== false) await run({ phase: "reconcile", label: "queue.start()", run: () => queue.start() });
  await reconcileAfterQueue(books, run, reconcilers);
  await run({ phase: "reconcile", label: "loadAndArmAll()", run: () => loadAndArmAll() });
  if (options.startQueue !== false && options.startTrending !== false) trendingScheduler.start();
  if (options.startPostMetrics !== false) startPostMetricsScheduler();
}

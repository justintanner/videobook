/* Startup benchmark: replicates server/src/index.ts start() phase by phase,
 * skipping queue.start(), with per-import and per-book attribution. Run under
 * `node --cpu-prof --import tsx scripts/benchmark-startup.ts out.json` for
 * function-level attribution. doltlite prototypes are frozen; SQL attribution
 * is impossible — use CPU profiling instead of sqlStats scaffolding.
 *
 * Usage:
 *   npm run benchmark:startup [out.json] [--assert-listen-ms N] [--assert-ready-ms N]
 */
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";

type Row = { phase: string; label: string; ms: number };

function parseArgs(argv: string[]): {
  out: string;
  assertListenMs?: number;
  assertReadyMs?: number;
} {
  let out = "/dev/stdout";
  let assertListenMs: number | undefined;
  let assertReadyMs: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--assert-listen-ms") {
      const raw = argv[index + 1];
      if (!raw) throw new Error("--assert-listen-ms requires a number");
      assertListenMs = Number(raw);
      index += 1;
      continue;
    }
    if (arg.startsWith("--assert-listen-ms=")) {
      assertListenMs = Number(arg.slice("--assert-listen-ms=".length));
      continue;
    }
    if (arg === "--assert-ready-ms") {
      const raw = argv[index + 1];
      if (!raw) throw new Error("--assert-ready-ms requires a number");
      assertReadyMs = Number(raw);
      index += 1;
      continue;
    }
    if (arg.startsWith("--assert-ready-ms=")) {
      assertReadyMs = Number(arg.slice("--assert-ready-ms=".length));
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    out = arg;
  }
  return { out, assertListenMs, assertReadyMs };
}

let args: ReturnType<typeof parseArgs>;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const rows: Row[] = [];

function record(phase: string, label: string, ms: number): void {
  rows.push({ phase, label, ms });
  console.error(`[${phase}] ${label}: ${ms.toFixed(1)} ms`);
}

async function timed<T>(
  phase: string,
  label: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    record(phase, label, performance.now() - t0);
  }
}

const T_START = performance.now();

await timed("import", "load-env", () => import("../server/src/load-env.ts"));
const engineMod = await timed("import", "videobook-engine (barrel)", () =>
  import("videobook-engine"),
);
await timed("import", "acestep/process", () =>
  import("../server/src/acestep/process.ts"),
);
await timed("import", "archive-store", () =>
  import("../server/src/archive-store.ts"),
);
const engineTs = await timed("import", "engine (bookManager)", () =>
  import("../server/src/engine.ts"),
);
const jobsIndex = await timed("import", "jobs/index", () =>
  import("../server/src/jobs/index.ts"),
);
await timed("import", "local-upload", () =>
  import("../server/src/local-upload.ts"),
);
await timed("import", "queue", () => import("../server/src/queue.ts"));
await timed("import", "search-reference-store", () =>
  import("../server/src/search-reference-store.ts"),
);
const sched = await timed("import", "scheduled-posts", () =>
  import("../server/src/scheduled-posts.ts"),
);
const serverTs = await timed("import", "server (createHttpHandler)", () =>
  import("../server/src/server.ts"),
);
await timed("import", "http-byte-range", () =>
  import("../server/src/http-byte-range.ts"),
);
record("import", "TOTAL imports", performance.now() - T_START);

const { bookManager, scopedEngine } = engineTs;
const mcpHandler = await timed("init", "createHttpHandler()", () =>
  serverTs.createHttpHandler(scopedEngine, bookManager),
);
await timed("init", "registerAllJobHandlers()", () =>
  jobsIndex.registerAllJobHandlers(scopedEngine),
);
record("init", "TIME-TO-LISTEN (imports+init)", performance.now() - T_START);

const roots = await timed("open", "bookManager.discover() [readdir]", () =>
  bookManager.discover(),
);
console.error(`books: ${roots.length}`);
const perBook: Array<Record<string, unknown>> = [];
for (const bookId of roots) {
  const root = `${bookManager.rootDir}/${bookId}`;
  const t0 = performance.now();
  const engine = engineMod.createEngine({
    rootDir: root,
    objectPrefix: "superlzy-media/videobook/sha256",
  });
  const ctorMs = performance.now() - t0;
  const t1 = performance.now();
  await engine.ready;
  const readyMs = performance.now() - t1;
  const t2 = performance.now();
  const artifacts = engine.artifacts.list();
  const artifactsMs = performance.now() - t2;
  const t3 = performance.now();
  const notebooks = engine.notebooks.list();
  const notebooksMs = performance.now() - t3;
  const gc = engine.lastCatalogGc;
  perBook.push({
    bookId,
    name: engine.book.get().name,
    ctorMs,
    readyMs,
    artifactsMs,
    notebooksMs,
    artifactCount: artifacts.length,
    notebookCount: notebooks.length,
    ...(gc
      ? {
          gcTrigger: gc.trigger,
          gcBytesBefore: gc.bytesBefore,
          gcBytesAfter: gc.bytesAfter,
          gcSummary: gc.summary,
        }
      : {}),
  });
  console.error(
    `  ${engine.book.get().name} ctor=${ctorMs.toFixed(1)} ready=${readyMs.toFixed(1)} artifacts=${artifactsMs.toFixed(1)} notebooks=${notebooksMs.toFixed(1)}`,
  );
  engine.close();
}

await timed("open", "bookManager.ready()", () => bookManager.ready());

const imageSubjects = await timed("import", "jobs/image-subjects (hydrate)", () =>
  import("../server/src/jobs/image-subjects.ts"),
);
const runNotebook = await timed("import", "jobs/run-notebook (hydrate)", () =>
  import("../server/src/jobs/run-notebook.ts"),
);
if (process.env.VIDEOBOOK_DEV_FIXTURES === "1") {
  const dancing = await timed("import", "dancing-workflow (fixtures)", () =>
    import("../server/src/dancing-workflow.ts"),
  );
  await timed("reconcile", "ensureDancingWorkflow()", () =>
    dancing.ensureDancingWorkflow(bookManager),
  );
}

for (const book of bookManager.list()) {
  const selected = bookManager.get(book.bookId);
  if (!selected.ok) continue;
  const e = selected.value.engine;
  const tag = `${book.name} [${book.bookId.slice(0, 8)}]`;
  await timed("reconcile", `${tag} jobs.queue.reap()`, () => e.jobs.queue.reap());
  await timed("reconcile", `${tag} reconcileImageSubjectJobFailures`, () =>
    imageSubjects.reconcileImageSubjectJobFailures(e, book.bookId),
  );
  await timed("reconcile", `${tag} abortLeasedNotebookRunsOnStartup`, () =>
    runNotebook.abortLeasedNotebookRunsOnStartup(e),
  );
  await timed("reconcile", `${tag} reconcileGenerationMediaOutputs`, () =>
    runNotebook.reconcileGenerationMediaOutputs(e),
  );
  await timed("reconcile", `${tag} reconcileQueuedNotebookCells`, () =>
    runNotebook.reconcileQueuedNotebookCells(e),
  );
}
record("reconcile", "SKIPPED queue.start()", 0);
for (const book of bookManager.list()) {
  const selected = bookManager.get(book.bookId);
  if (!selected.ok) continue;
  await timed(
    "reconcile",
    `${book.name} [${book.bookId.slice(0, 8)}] reconcileAwaitingNotebookOutputs`,
    () =>
      runNotebook.reconcileAwaitingNotebookOutputs(
        selected.value.engine,
        book.bookId,
      ),
  );
}
await timed("reconcile", "loadAndArmAll()", () => sched.loadAndArmAll());
sched.stopScheduler();
record("total", "TIME-TO-HYDRATED (list_books unblocks)", performance.now() - T_START);

const mem = process.memoryUsage();
await timed("shutdown", "mcpHandler.close()", () => mcpHandler.close());
await timed("shutdown", "bookManager.close()", () => bookManager.close());

const summary = {
  rows,
  perBook,
  rssMB: Math.round(mem.rss / 1048576),
  heapMB: Math.round(mem.heapUsed / 1048576),
};
writeFileSync(args.out, JSON.stringify(summary, null, 2));
console.error(`rss=${summary.rssMB}MB heap=${summary.heapMB}MB`);

function rowMs(labelPart: string): number | undefined {
  return rows.find((row) => row.label.includes(labelPart))?.ms;
}

const listenMs = rowMs("TIME-TO-LISTEN");
const readyMs = rowMs("bookManager.ready()");
if (args.assertListenMs !== undefined) {
  if (listenMs === undefined || listenMs > args.assertListenMs) {
    console.error(
      `TIME-TO-LISTEN ${listenMs?.toFixed(1) ?? "missing"} ms exceeds --assert-listen-ms ${args.assertListenMs}`,
    );
    process.exit(1);
  }
}
if (args.assertReadyMs !== undefined) {
  if (readyMs === undefined || readyMs > args.assertReadyMs) {
    console.error(
      `bookManager.ready() ${readyMs?.toFixed(1) ?? "missing"} ms exceeds --assert-ready-ms ${args.assertReadyMs}`,
    );
    process.exit(1);
  }
}

process.exit(0);

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import type { Engine } from "videobook-engine";
import { testQueueCleanup } from "../test-queue-cleanup.js";

let root: string | undefined;
let engine: Engine | undefined;
let queueModule: typeof import("../queue.js") | undefined;
let completed = false;

it("does not load the queue for a pure test", () => {
  expect(testQueueCleanup.waitForIdle).toBeUndefined();
  expect(testQueueCleanup.drain).toBeUndefined();
});

it("keeps the queue unloaded after pure-test cleanup", () => {
  expect(testQueueCleanup.waitForIdle).toBeUndefined();
  expect(testQueueCleanup.drain).toBeUndefined();
});

it("registers cleanup when a test imports and starts the real queue", async () => {
  queueModule = await import("../queue.js");
  const { createEngine } = await import("videobook-engine");
  root = await mkdtemp(join(tmpdir(), "videobook-queue-cleanup-probe-"));
  engine = createEngine({ rootDir: root, initialBookName: "cleanup-probe", durableWrites: false });
  await queueModule.setEngineRoot(root, engine);
  queueModule.registerJobHandler("cleanup_probe", async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    completed = true;
  });
  await queueModule.queue.enqueue("cleanup-probe", {
    type: "cleanup_probe",
    bookId: engine.book.get().bookId,
  });
  expect(completed).toBe(false);
  expect(testQueueCleanup.waitForIdle).toBeTypeOf("function");
  expect(testQueueCleanup.drain).toBeTypeOf("function");
});

it("waits for the preceding test's unfinished job before starting the next test", () => {
  expect(completed).toBe(true);
  expect(engine?.jobs.queue.list({ type: "cleanup_probe" })[0]?.state).toBe("done");
  expect(queueModule?.isProviderPollDriverActive(engine!.book.get().bookId)).toBe(true);
});

afterAll(async () => {
  try {
    expect(engine).toBeDefined();
    expect(queueModule?.isProviderPollDriverActive(engine!.book.get().bookId)).toBe(false);
  } finally {
    await queueModule?.queue.stop();
    engine?.close();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

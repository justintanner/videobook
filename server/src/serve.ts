import { once } from "node:events";
import type { Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { stopAceServer } from "./acestep/process.js";
import { createApp, type VideobookApp } from "./app.js";
import type { BookManager, ManagedBook } from "./book-manager.js";
import { bookManager, scopedEngine } from "./engine.js";
import { registerAllJobHandlers } from "./jobs/index.js";
import { logger } from "./logger.js";
import { startPostMetricsScheduler, stopPostMetricsScheduler } from "./posts/post-metrics.js";
import { queue } from "./queue.js";
import { loadAndArmAll, stopScheduler } from "./scheduled-posts.js";
import { attachVoiceAudio } from "./voice-audio.js";

const LOOPBACK_HOST = "127.0.0.1";
const SHUTDOWN_WATCHDOG_MS = 20_000;
const HTTP_CLOSE_GRACE_MS = 2_000;

export interface ServeOptions {
  port: number;
}

export interface RunningServer {
  port: number;
  url: string;
  mcpUrl: string;
  ready: Promise<void>;
  close(): Promise<void>;
}

function openBooks(books: BookManager): ManagedBook[] {
  return books.list().flatMap((book) => {
    const selected = books.get(book.bookId);
    return selected.ok ? [selected.value] : [];
  });
}

async function hydrateLibrary(
  books: BookManager,
  options: { devFixtures: boolean },
): Promise<void> {
  await books.ready();
  if (options.devFixtures) {
    const { ensureDancingWorkflow } = await import("./dancing-workflow.js");
    await ensureDancingWorkflow(books);
  }
  const imageSubjects = await import("./jobs/image-subjects.js");
  const runNotebook = await import("./jobs/run-notebook.js");
  for (const book of openBooks(books)) {
    await book.engine.jobs.queue.reap();
    await imageSubjects.reconcileImageSubjectJobFailures(book.engine, book.bookId);
    await runNotebook.abortLeasedNotebookRunsOnStartup(book.engine);
    await runNotebook.reconcileGenerationMediaOutputs(book.engine);
    await runNotebook.reconcileQueuedNotebookCells(book.engine);
  }
  await queue.start();
  for (const book of openBooks(books)) {
    await runNotebook.reconcileAwaitingNotebookOutputs(book.engine, book.bookId);
  }
  await loadAndArmAll();
  startPostMetricsScheduler();
}

async function shutdownServices(services: VideobookApp): Promise<void> {
  stopScheduler();
  stopPostMetricsScheduler();
  await services.voiceSessions.close();
  await services.mcpHandler.close();
  await queue.stop();
  await stopAceServer();
  await bookManager.close();
}

async function finishHttpClose(server: Server, closed: Promise<void>): Promise<void> {
  server.closeAllConnections();
  await Promise.race([closed, delay(HTTP_CLOSE_GRACE_MS, undefined, { ref: false })]);
}

function closer(server: Server, services: VideobookApp, onClosing: () => void): () => Promise<void> {
  let closing: Promise<void> | undefined;
  async function run(): Promise<void> {
    onClosing();
    const closed = new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    try {
      await shutdownServices(services);
      logger.info("shutdown-complete");
    } catch (error) {
      logger.error("shutdown-failed", { error });
      throw error;
    } finally {
      await finishHttpClose(server, closed);
    }
  }
  return () => {
    closing ??= run();
    return closing;
  };
}

function boundPort(server: Server, fallback: number): number {
  const address = server.address();
  return address && typeof address !== "string" ? address.port : fallback;
}

function startHydration(isClosing: () => boolean): Promise<void> {
  const ready = hydrateLibrary(bookManager, {
    devFixtures: process.env.VIDEOBOOK_DEV_FIXTURES === "1",
  }).catch((error: unknown) => {
    if (!isClosing()) throw error;
  });
  ready.catch(() => undefined);
  return ready;
}

export async function startServer(options: ServeOptions): Promise<RunningServer> {
  registerAllJobHandlers(scopedEngine);
  const services = createApp();
  const server = services.app.listen(options.port, LOOPBACK_HOST);
  await once(server, "listening");
  const port = boundPort(server, options.port);
  logger.info("server-listening", { port });
  attachVoiceAudio(server, services.voiceSessions);
  let closing = false;
  const close = closer(server, services, () => {
    closing = true;
  });
  const url = `http://${LOOPBACK_HOST}:${port}`;
  return {
    port,
    url,
    mcpUrl: `${url}/mcp`,
    ready: startHydration(() => closing),
    close,
  };
}

export function installSignalHandlers(
  starting: Promise<RunningServer>,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  let stopping = false;
  function stop(): void {
    if (stopping) return;
    stopping = true;
    setTimeout(() => exit(1), SHUTDOWN_WATCHDOG_MS).unref();
    starting
      .then((running) => running.close())
      .then(() => exit(0), () => exit(1));
  }
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

import { stopTrendingSchedulerAndQueue } from "./trending/scheduler.js";
import { flushHarCaptures } from "./har-capture.js";
import { once } from "node:events";
import type { Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { stopAceServer } from "./acestep/process.js";
import { createApp, type UiStatus, type VideobookApp } from "./app.js";
import { bookManager, scopedEngine } from "./engine.js";
import { getDefaultSecretStore } from "./env-secrets.js";
import { hydrateLibrary } from "./hydration.js";
import { registerAllJobHandlers } from "./jobs/index.js";
import { logger } from "./logger.js";
import { stopPostMetricsScheduler } from "./posts/post-metrics.js";
import { stopScheduler } from "./scheduled-posts.js";
import { SERVER_VERSION } from "./server.js";
import {
  ServerAlreadyRunningError,
  acquireServerLock,
  inspectServerOwner,
  type ServerLockHandle,
} from "./server-lock.js";
import { attachVoiceAudio } from "./voice-audio.js";

const LOOPBACK_HOST = "127.0.0.1";
const SHUTDOWN_WATCHDOG_MS = 20_000;
const HTTP_CLOSE_GRACE_MS = 2_000;

export interface ServeOptions {
  port: number;
  ui: boolean;
  uiDir?: string;
}

export interface RunningServer {
  port: number;
  url: string;
  mcpUrl: string;
  libraryDir: string;
  uiDir: string;
  uiStatus: UiStatus;
  ready: Promise<void>;
  close(): Promise<void>;
}

async function shutdownServices(services: VideobookApp): Promise<void> {
  stopScheduler();
  stopPostMetricsScheduler();
  await services.voiceSessions.close();
  await services.mcpHandler.close();
  await stopTrendingSchedulerAndQueue();
  await flushHarCaptures();
  await stopAceServer();
  await bookManager.close();
}

async function finishHttpClose(server: Server, closed: Promise<void>): Promise<void> {
  server.closeAllConnections();
  await Promise.race([closed, delay(HTTP_CLOSE_GRACE_MS, undefined, { ref: false })]);
}

function closer(
  server: Server,
  services: VideobookApp,
  lock: ServerLockHandle,
  onClosing: () => void,
): () => Promise<void> {
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
      await lock.release();
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

async function refuseRunningOwner(libraryDir: string): Promise<void> {
  const owner = await inspectServerOwner(libraryDir);
  if (owner.kind === "none") return;
  throw new ServerAlreadyRunningError(owner.record, libraryDir, owner.kind === "running");
}

async function claimLibrary(server: Server, libraryDir: string, port: number, url: string): Promise<ServerLockHandle> {
  try {
    return await acquireServerLock(libraryDir, { pid: process.pid, port, url, version: SERVER_VERSION });
  } catch (error) {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    throw error;
  }
}

export async function startServer(options: ServeOptions): Promise<RunningServer> {
  const libraryDir = bookManager.rootDir;
  await refuseRunningOwner(libraryDir);
  getDefaultSecretStore().resolveOnePassword();
  registerAllJobHandlers(scopedEngine);
  const services = createApp({ ui: options.ui, uiDir: options.uiDir });
  const server = services.app.listen(options.port, LOOPBACK_HOST);
  await once(server, "listening");
  const port = boundPort(server, options.port);
  const url = `http://${LOOPBACK_HOST}:${port}`;
  const lock = await claimLibrary(server, libraryDir, port, url);
  logger.info("server-listening", { port });
  attachVoiceAudio(server, services.voiceSessions);
  let closing = false;
  const close = closer(server, services, lock, () => {
    closing = true;
  });
  return {
    port,
    url,
    mcpUrl: `${url}/mcp`,
    libraryDir,
    uiDir: services.uiDir,
    uiStatus: services.uiStatus,
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

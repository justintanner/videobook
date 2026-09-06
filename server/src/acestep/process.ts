import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { isHealthy } from "./client.js";
import { aceStepConfig, checkLocalAvailability, type AceStepConfig } from "./config.js";
import { logger } from "../logger.js";
import { AceStepError } from "./errors.js";

interface AceServerHandle {
  baseUrl: string;
  owned: boolean;
}

interface AceServerState {
  child: ChildProcess | null;
  handle: AceServerHandle | null;
  starting: Promise<AceServerHandle> | null;
  spawnFailure: AceStepError | null;
  lock: Promise<unknown>;
}

const state: AceServerState = {
  child: null,
  handle: null,
  starting: null,
  spawnFailure: null,
  lock: Promise.resolve(),
};

const HEALTH_POLL_INTERVAL_MS = 500;
const HEALTH_POLL_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 700;
const EXTERNAL_HEALTH_ATTEMPTS = 3;
const STOP_GRACE_MS = 2_000;

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function drainOutput(stream: Readable | null): void {
  if (stream === null) return;
  stream.resume();
}

// Identity check before adopting a listener on our port: /health must return the
// documented {"status":"ok"} shape and /props must serve JSON, so we never treat
// an unrelated local service as ace-server.
async function probeAceServer(baseUrl: string): Promise<boolean> {
  try {
    const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!health.ok) return false;
    const healthBody = (await health.json()) as { status?: unknown };
    if (healthBody?.status !== "ok") return false;
    const props = await fetch(`${baseUrl}/props`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!props.ok) return false;
    const propsBody: unknown = await props.json();
    return typeof propsBody === "object" && propsBody !== null;
  } catch {
    return false;
  }
}

async function startServer(config: AceStepConfig, signal?: AbortSignal): Promise<AceServerHandle> {
  const baseUrl = `http://127.0.0.1:${config.port}`;
  if (await probeAceServer(baseUrl)) {
    const adopted: AceServerHandle = { baseUrl, owned: false };
    state.handle = adopted;
    return adopted;
  }

  const availability = checkLocalAvailability(config);
  if (!availability.available) {
    throw new AceStepError(
      availability.kind === "models_missing" ? "models_missing" : "binary_missing",
      availability.reason,
    );
  }

  const serverArgs = [
    "--models",
    config.modelsDir,
    "--host",
    "127.0.0.1",
    "--port",
    String(config.port),
  ];
  if (config.keepLoaded) serverArgs.push("--keep-loaded");
  const child = spawn(config.serverPath, serverArgs, { stdio: ["ignore", "pipe", "pipe"] });
  drainOutput(child.stdout);
  drainOutput(child.stderr);
  state.child = child;
  state.spawnFailure = null;
  child.on("error", (error) => {
    state.spawnFailure = new AceStepError(
      "spawn_failed",
      `Failed to start ace-server at ${config.serverPath}: ${error.message}`,
    );
  });
  child.on("exit", (code, exitSignal) => {
    logger.error("ace-server-exited", { exitCode: code, signal: exitSignal });
    if (state.child === child) {
      state.child = null;
      state.handle = null;
    }
  });

  const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      child.kill("SIGKILL");
      state.child = null;
      signal.throwIfAborted();
    }
    if (state.spawnFailure !== null) throw state.spawnFailure;
    if (child.exitCode !== null) {
      throw new AceStepError(
        "spawn_failed",
        `ace-server exited during startup (code ${child.exitCode}); run the configured server directly to inspect its output`,
      );
    }
    if (await isHealthy(baseUrl, PROBE_TIMEOUT_MS)) {
      const owned: AceServerHandle = { baseUrl, owned: true };
      state.handle = owned;
      return owned;
    }
    await delay(HEALTH_POLL_INTERVAL_MS);
  }
  child.kill("SIGKILL");
  state.child = null;
  throw new AceStepError(
    "health_timeout",
    `ace-server did not become healthy on ${baseUrl} within ${HEALTH_POLL_TIMEOUT_MS}ms`,
  );
}

export async function ensureAceServer(options: { signal?: AbortSignal } = {}): Promise<AceServerHandle> {
  const config = aceStepConfig();
  if (config.baseUrl !== null) {
    for (let attempt = 0; attempt < EXTERNAL_HEALTH_ATTEMPTS; attempt += 1) {
      if (await probeAceServer(config.baseUrl)) return { baseUrl: config.baseUrl, owned: false };
      if (attempt < EXTERNAL_HEALTH_ATTEMPTS - 1) await delay(PROBE_TIMEOUT_MS);
    }
    throw new AceStepError(
      "unreachable",
      `ace-server at ${config.baseUrl} is not responding (VIDEOBOOK_ACESTEP_BASE_URL). Start it or unset the variable.`,
    );
  }

  if (state.handle !== null && (await isHealthy(state.handle.baseUrl, PROBE_TIMEOUT_MS))) {
    return state.handle;
  }
  if (state.starting !== null) return state.starting;
  state.starting = startServer(config, options.signal);
  try {
    return await state.starting;
  } finally {
    state.starting = null;
  }
}

// ace-server runs one GPU job at a time on a FIFO worker thread and evicts
// completed jobs past a small cap while holding every result in memory, so we
// keep at most one videobook synthesis in flight: queued covers wait here
// instead of piling result buffers onto the server.
export async function withSynthLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = state.lock;
  let release: (() => void) | undefined;
  state.lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release?.();
  }
}

export async function stopAceServer(): Promise<void> {
  const child = state.child;
  state.child = null;
  state.handle = null;
  state.starting = null;
  if (child === null || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  child.kill("SIGTERM");
  const outcome = await Promise.race([
    exited.then(() => "exited" as const),
    delay(STOP_GRACE_MS).then(() => "timeout" as const),
  ]);
  if (outcome === "timeout") {
    child.kill("SIGKILL");
    await exited;
  }
}

export function resetAceStepForTests(): void {
  state.child?.kill("SIGKILL");
  state.child = null;
  state.handle = null;
  state.starting = null;
  state.spawnFailure = null;
  state.lock = Promise.resolve();
}

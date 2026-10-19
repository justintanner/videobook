import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const SERVER_LOCK_FILENAME = ".videobook-server.json";
const HEALTH_TIMEOUT_MS = 1_500;

export interface ServerLockRecord {
  pid: number;
  port: number;
  url: string;
  startedAt: string;
  version: string;
}

export interface ServerLockHandle {
  path: string;
  record: ServerLockRecord;
  release(): Promise<void>;
}

export type ServerOwner =
  | { kind: "none" }
  | { kind: "running"; record: ServerLockRecord }
  | { kind: "unresponsive"; record: ServerLockRecord };

type HealthAnswer = "videobook" | "other" | "refused" | "timeout";

export class ServerAlreadyRunningError extends Error {
  readonly running: ServerLockRecord;
  readonly libraryDir: string;

  constructor(running: ServerLockRecord, libraryDir: string, responding: boolean) {
    super(responding
      ? `videobook is already running at ${running.url} (pid ${running.pid}) for library ${libraryDir}. Open that URL or stop it first.`
      : `videobook (pid ${running.pid}) holds library ${libraryDir} at ${running.url} but is not responding. Stop that process first.`);
    this.name = "ServerAlreadyRunningError";
    this.running = running;
    this.libraryDir = libraryDir;
  }
}

export function serverLockPath(libraryDir: string): string {
  return join(libraryDir, SERVER_LOCK_FILENAME);
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function parseServerLock(raw: string): ServerLockRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof ServerLockRecord, unknown>>;
    if (typeof value.pid !== "number" || typeof value.port !== "number" || typeof value.url !== "string") return null;
    return {
      pid: value.pid,
      port: value.port,
      url: value.url,
      startedAt: typeof value.startedAt === "string" ? value.startedAt : "",
      version: typeof value.version === "string" ? value.version : "",
    };
  } catch {
    return null;
  }
}

export async function readServerLock(libraryDir: string): Promise<ServerLockRecord | null> {
  try {
    return parseServerLock(await readFile(serverLockPath(libraryDir), "utf8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function healthFailure(error: unknown): HealthAnswer {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "timeout";
  return "refused";
}

async function askHealth(url: string, timeoutMs: number): Promise<HealthAnswer> {
  try {
    const response = await fetch(new URL("/healthz", url), { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return "other";
    const body = await response.json() as { ok?: unknown; service?: unknown };
    return body.ok === true && body.service === "videobook" ? "videobook" : "other";
  } catch (error) {
    return healthFailure(error);
  }
}

export async function inspectServerOwner(
  libraryDir: string,
  timeoutMs: number = HEALTH_TIMEOUT_MS,
): Promise<ServerOwner> {
  const record = await readServerLock(libraryDir);
  if (!record || !processAlive(record.pid)) return { kind: "none" };
  const answer = await askHealth(record.url, timeoutMs);
  if (answer === "videobook") return { kind: "running", record };
  if (answer === "timeout") return { kind: "unresponsive", record };
  return { kind: "none" };
}

function sameRecord(left: ServerLockRecord | null, right: ServerLockRecord): boolean {
  return left !== null && left.pid === right.pid && left.startedAt === right.startedAt;
}

async function writeExclusive(path: string, record: ServerLockRecord): Promise<boolean> {
  const staging = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(staging, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await link(staging, path);
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  } finally {
    await unlink(staging).catch(() => undefined);
  }
}

async function removeIfUnchanged(libraryDir: string, expected: ServerLockRecord | null): Promise<void> {
  const current = await readServerLock(libraryDir);
  if (expected === null ? current !== null : !sameRecord(current, expected)) return;
  await unlink(serverLockPath(libraryDir)).catch((error: unknown) => {
    if (errorCode(error) !== "ENOENT") throw error;
  });
}

function lockHandle(libraryDir: string, record: ServerLockRecord): ServerLockHandle {
  let released = false;
  return {
    path: serverLockPath(libraryDir),
    record,
    async release() {
      if (released) return;
      released = true;
      await removeIfUnchanged(libraryDir, record);
    },
  };
}

export async function acquireServerLock(
  libraryDir: string,
  fields: Omit<ServerLockRecord, "startedAt">,
): Promise<ServerLockHandle> {
  await mkdir(libraryDir, { recursive: true });
  const record: ServerLockRecord = { ...fields, startedAt: new Date().toISOString() };
  const path = serverLockPath(libraryDir);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await writeExclusive(path, record)) return lockHandle(libraryDir, record);
    const stale = await readServerLock(libraryDir);
    const owner = await inspectServerOwner(libraryDir);
    if (owner.kind !== "none") throw new ServerAlreadyRunningError(owner.record, libraryDir, owner.kind === "running");
    await removeIfUnchanged(libraryDir, stale);
  }
  throw new Error(`Could not acquire the videobook server lock at ${path}`);
}

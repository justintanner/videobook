import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SERVER_LOCK_FILENAME,
  ServerAlreadyRunningError,
  acquireServerLock,
  inspectServerOwner,
  processAlive,
  readServerLock,
  serverLockPath,
} from "./server-lock.js";

interface TestHttp {
  url: string;
  close(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function libraryDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vb-server-lock-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return join(root, "books");
}

async function httpServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<TestHttp> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = address && typeof address !== "string" ? address.port : 0;
  const handle: TestHttp = {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolveClose) => {
      server.closeAllConnections();
      server.close(() => resolveClose());
    }),
  };
  cleanups.push(handle.close);
  return handle;
}

function healthAnswering(body: Record<string, unknown>): Promise<TestHttp> {
  return httpServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
}

async function closedPortUrl(): Promise<string> {
  const server = await httpServer(() => undefined);
  await server.close();
  return server.url;
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid ?? 0;
  await once(child, "exit");
  return pid;
}

async function writeLock(dir: string, record: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(serverLockPath(dir), JSON.stringify(record), "utf8");
}

describe("server lock", () => {
  it("writes the owner record and removes it on release", async () => {
    const dir = await libraryDir();
    const lock = await acquireServerLock(dir, { pid: process.pid, port: 4321, url: "http://127.0.0.1:4321", version: "9.9.9" });
    expect(lock.path).toBe(join(dir, SERVER_LOCK_FILENAME));
    expect(await readServerLock(dir)).toEqual({ ...lock.record, port: 4321, version: "9.9.9" });
    expect(lock.record.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(await readdir(dir)).toEqual([SERVER_LOCK_FILENAME]);
    await lock.release();
    await lock.release();
    expect(await readServerLock(dir)).toBeNull();
  });

  it("refuses a second owner while the first answers /healthz", async () => {
    const dir = await libraryDir();
    const health = await healthAnswering({ ok: true, service: "videobook" });
    const first = await acquireServerLock(dir, { pid: process.pid, port: 1, url: health.url, version: "1" });
    expect(await inspectServerOwner(dir)).toEqual({ kind: "running", record: first.record });
    const second = acquireServerLock(dir, { pid: process.pid, port: 2, url: "http://127.0.0.1:2", version: "1" });
    await expect(second).rejects.toBeInstanceOf(ServerAlreadyRunningError);
    await expect(second).rejects.toThrow(`videobook is already running at ${health.url} (pid ${process.pid})`);
    expect(await readServerLock(dir)).toEqual(first.record);
  });

  it("replaces a lock left by a process that has exited", async () => {
    const dir = await libraryDir();
    const pid = await deadPid();
    expect(processAlive(pid)).toBe(false);
    await writeLock(dir, { pid, port: 1, url: "http://127.0.0.1:1", startedAt: "old", version: "1" });
    expect(await inspectServerOwner(dir)).toEqual({ kind: "none" });
    const lock = await acquireServerLock(dir, { pid: process.pid, port: 2, url: "http://127.0.0.1:2", version: "1" });
    expect((await readServerLock(dir))?.pid).toBe(process.pid);
    await lock.release();
  });

  it("replaces a lock whose port now belongs to another service or nothing", async () => {
    const dir = await libraryDir();
    const other = await healthAnswering({ ok: true, service: "something-else" });
    await writeLock(dir, { pid: process.pid, port: 1, url: other.url, startedAt: "a", version: "1" });
    expect(await inspectServerOwner(dir)).toEqual({ kind: "none" });
    await writeLock(dir, { pid: process.pid, port: 1, url: await closedPortUrl(), startedAt: "b", version: "1" });
    expect(await inspectServerOwner(dir)).toEqual({ kind: "none" });
    const lock = await acquireServerLock(dir, { pid: process.pid, port: 3, url: "http://127.0.0.1:3", version: "1" });
    expect((await readServerLock(dir))?.port).toBe(3);
    await lock.release();
  });

  it("keeps a live owner that stops answering and reports it as unresponsive", async () => {
    const dir = await libraryDir();
    const hung = await httpServer(() => undefined);
    await writeLock(dir, { pid: process.pid, port: 1, url: hung.url, startedAt: "c", version: "1" });
    expect((await inspectServerOwner(dir, 200)).kind).toBe("unresponsive");
    await expect(acquireServerLock(dir, { pid: process.pid, port: 2, url: "http://127.0.0.1:2", version: "1" }))
      .rejects.toThrow("is not responding");
  });

  it("ignores a corrupt lock file", async () => {
    const dir = await libraryDir();
    await mkdir(dir, { recursive: true });
    await writeFile(serverLockPath(dir), "{not json", "utf8");
    expect(await readServerLock(dir)).toBeNull();
    const lock = await acquireServerLock(dir, { pid: process.pid, port: 5, url: "http://127.0.0.1:5", version: "1" });
    expect((await readServerLock(dir))?.port).toBe(5);
    await lock.release();
  });

  it("never removes a lock that a newer owner has written", async () => {
    const dir = await libraryDir();
    const lock = await acquireServerLock(dir, { pid: process.pid, port: 6, url: "http://127.0.0.1:6", version: "1" });
    await writeLock(dir, { pid: process.pid, port: 7, url: "http://127.0.0.1:7", startedAt: "newer", version: "1" });
    await lock.release();
    expect(JSON.parse(await readFile(serverLockPath(dir), "utf8"))).toMatchObject({ port: 7, startedAt: "newer" });
  });
});

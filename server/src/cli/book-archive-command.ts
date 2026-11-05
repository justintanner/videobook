import { resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { packBookArchive, inspectBookArchive, restoreBookArchive, releaseBookSnapshot, releaseBookImportWorkspace, type BookSnapshot } from "videobook-engine";
import { bookManager } from "../engine.js";
import { acquireServerLock, inspectServerOwner } from "../server-lock.js";
import type { BookArchiveFlags } from "./args.js";

interface ArchiveSession {
  call<T>(args: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

async function session(): Promise<ArchiveSession> {
  const owner = await inspectServerOwner(bookManager.rootDir);
  if (owner.kind === "unresponsive") throw new Error(`Videobook pid ${owner.record.pid} owns the library but is not responding; retry after it is ready`);
  if (owner.kind === "running") {
    const client = new Client({ name: "videobook-archive-cli", version: "1" }, {
      capabilities: {}, supportedProtocolVersions: ["2026-07-28"], versionNegotiation: { mode: { pin: "2026-07-28" } },
    });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${owner.record.url}/mcp`)));
      if (!(await client.listTools()).tools.some((tool) => tool.name === "book_archive")) {
        throw new Error("The running Videobook does not support portable archives; update the running app to 0.4.3 or newer");
      }
    }
    catch (error) { await client.close(); throw error; }
    return {
      async call<T>(args: Record<string, unknown>): Promise<T> {
        const result = await client.callTool({ name: "book_archive", arguments: { ...args, client_pid: process.pid } }, { timeout: 30 * 60_000 });
        const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
        if (result.isError) throw new Error(text);
        return JSON.parse(text) as T;
      },
      close: () => client.close(),
    };
  }
  const lock = await acquireServerLock(bookManager.rootDir, { pid: process.pid, port: 0, url: "http://127.0.0.1:0", version: "archive-cli" });
  return {
    async call<T>(args: Record<string, unknown>): Promise<T> {
      let result: unknown;
      if (args.op === "snapshot") result = await bookManager.prepareExport(String(args.book));
      else if (args.op === "prepare_import") result = await bookManager.prepareImport({
        bookId: String(args.book_id), name: String(args.name), createdAt: Number(args.created_at),
      }, String(args.head));
      else if (args.op === "commit_import") result = await bookManager.commitImport(String(args.token));
      else { await bookManager.releaseArchive(String(args.token)); result = { released: true }; }
      return result as T;
    },
    async close() {
      try { await bookManager.close(); }
      finally { await lock.release(); }
    },
  };
}

export async function runBookArchiveCommand(command: { command: "export-book" | "import-book"; reference: string; flags: BookArchiveFlags }): Promise<number> {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Book archive operation cancelled"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let owner: ArchiveSession | undefined;
  let token: string | undefined;
  let snapshotRoot: string | undefined;
  let importRoot: string | undefined;
  try {
    owner = await session();
    if (command.command === "export-book") {
      process.stderr.write(`Taking a consistent snapshot of ${command.reference}...\n`);
      const snapshot = await owner.call<BookSnapshot & { token: string }>({ op: "snapshot", book: command.reference });
      token = snapshot.token;
      snapshotRoot = snapshot.rootDir;
      controller.signal.throwIfAborted();
      process.stderr.write(`Packing ${snapshot.manifest.objects.length} content objects...\n`);
      const result = await packBookArchive(snapshot.rootDir, resolve(command.flags.out!), { signal: controller.signal });
      process.stdout.write(command.flags.json ? `${JSON.stringify(result)}\n`
        : `Exported ${result.manifest.book.name} to ${result.path}\n${result.size} bytes\nSHA-256 ${result.sha256}\n`);
    } else {
      const path = resolve(command.reference);
      process.stderr.write("Inspecting book archive...\n");
      const manifest = await inspectBookArchive(path);
      controller.signal.throwIfAborted();
      const staging = await owner.call<{ token: string; rootDir: string }>({ op: "prepare_import", book_id: manifest.book.bookId,
        name: manifest.book.name, created_at: manifest.book.createdAt, head: manifest.head });
      token = staging.token;
      importRoot = staging.rootDir;
      process.stderr.write(`Restoring and verifying ${manifest.book.name}...\n`);
      await restoreBookArchive(path, staging.rootDir, { signal: controller.signal });
      controller.signal.throwIfAborted();
      const book = await owner.call<{ bookId: string; name: string }>({ op: "commit_import", token });
      process.stdout.write(command.flags.json ? `${JSON.stringify({ book, automation_paused: true, manifest })}\n`
        : `Imported ${book.name} (${book.bookId}).\nAutomatic publishing, research and metrics schedules are paused.\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    try {
      if (owner && token) await owner.call({ op: "release", token });
    } catch (error) {
      process.stderr.write(`Archive scratch cleanup: ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      try {
        if (snapshotRoot) await releaseBookSnapshot(snapshotRoot);
        if (importRoot) await releaseBookImportWorkspace(importRoot, bookManager.rootDir);
      } finally { await owner?.close(); }
    }
  }
}

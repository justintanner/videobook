import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import type { Engine } from "videobook-engine";
import { diagnosticErrorCode, diagnosticRecord, registerDiagnosticName, type DiagnosticEvent, type DiagnosticFields } from "./diagnostics.js";
import { configureLoggerForTests, logger, resetLoggerForTests } from "./logger.js";
import { closeEngineForTest, createEngineForTest } from "./engine.js";
import { BookManager } from "./book-manager.js";
import { queue, registerJobHandler, setEngineRoot } from "./queue.js";
import { failPendingTaskAndLog } from "./jobs/task-failure.js";
import { withLogging } from "./tools/log-wrapper.js";
import { listPromptHistoryDef, recordPromptDef } from "./tools/prompt-history.js";

const PRIVATE = "Confidential transcript and prompt /private/media.mov https://media.example/video?token=plaincredential";
const ID = "01900000-0000-7000-8000-000000000001";

function capture(): string[] {
  const lines: string[] = [];
  const collect = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  configureLoggerForTests({ level: "debug", sink: { error: collect, warn: collect, info: collect, debug: collect } });
  return lines;
}

function value<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("private runtime diagnostics", () => {
  let root: string | undefined;
  let engine: Engine | undefined;

  afterEach(async () => {
    await queue.stop();
    if (root && engine) closeEngineForTest(root, engine);
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 });
    resetLoggerForTests();
  });

  async function open(): Promise<Engine> {
    root = await mkdtemp(join(tmpdir(), "videobook-diagnostics-"));
    engine = createEngineForTest(root);
    await setEngineRoot(root, engine);
    return engine;
  }

  it("retains only allowlisted codes, registered operations and validated fields at every log level", () => {
    const lines = capture();
    registerDiagnosticName("tool", "diagnostic_probe");
    const error = Object.assign(new Error(PRIVATE), { code: "ENOENT", path: PRIVATE, cause: PRIVATE });
    for (const level of ["error", "warn", "info", "debug"] as const) {
      logger[level]("mcp", {
        error, tool: "diagnostic_probe", status: "error", durationMs: 17,
        artifactId: ID, bookId: PRIVATE, jobId: PRIVATE, reason: PRIVATE,
        provider: PRIVATE, stage: PRIVATE, signal: PRIVATE, prompt: PRIVATE,
        stderr: PRIVATE, token: PRIVATE, toJSON: () => { throw new Error("Must not serialize input"); },
      } as DiagnosticFields);
    }
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(JSON.parse(line.slice("[mcp] ".length))).toEqual({
        event: "mcp", artifactId: ID, durationMs: 17, status: "error", tool: "diagnostic_probe", errorCode: "ENOENT",
      });
    }
    expect(lines.join("\n")).not.toContain(PRIVATE);
    expect(diagnosticRecord("job-error", { jobType: "unregistered_private_value", errorCode: PRIVATE })).toEqual({ event: "job-error", errorCode: "UNKNOWN" });
    logger.error(PRIVATE as DiagnosticEvent, { error: PRIVATE });
    expect(lines.at(-1)).toBe('[unknown-event] {"event":"unknown-event","errorCode":"UNKNOWN"}');
  });

  it("never invokes getters, serializes exceptions or infers codes from user text", () => {
    let getterCalls = 0;
    const object = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(object, "code", { get() { getterCalls += 1; throw new Error(PRIVATE); } });
    Object.defineProperty(object, "error", { get() { getterCalls += 1; throw new Error(PRIVATE); } });
    expect(diagnosticErrorCode(object)).toBe("UNKNOWN");
    expect(diagnosticRecord("mcp", object)).toEqual({ event: "mcp" });
    expect(getterCalls).toBe(0);
    expect(diagnosticErrorCode(`OFFLINE ${PRIVATE}`)).toBe("UNKNOWN");
    expect(diagnosticErrorCode({ error: { code: "OFFLINE", message: PRIVATE } })).toBe("OFFLINE");
    expect(diagnosticErrorCode({ code: PRIVATE, message: PRIVATE })).toBe("UNKNOWN");
    expect(diagnosticRecord("mcp", { durationMs: Infinity, count: NaN, port: 0, exitCode: 1e9, bookId: ID + "\n" })).toEqual({ event: "mcp" });
    registerDiagnosticName("tool", "invalid_name\n");
    expect(diagnosticRecord("mcp", { tool: "invalid_name\n" })).toEqual({ event: "mcp" });
  });

  it.each(["diagnostic_failure", "semantic_index"])("preserves full %s job errors while persisting only safe diagnostics", async (type) => {
    const current = await open();
    const artifact = value(await current.artifacts.create("image", "Private asset title"));
    const bookId = current.book.get().bookId;
    const failure = Object.assign(new Error(PRIVATE), { code: "OFFLINE" });
    registerJobHandler(type, async () => { throw failure; });
    await expect(queue.enqueueAndWait("private-diagnostic-attempt", {
      type, bookId, assetId: artifact.artifactId, prompt: PRIVATE, runId: PRIVATE,
    }, 5_000)).rejects.toThrow(PRIVATE);
    const status = await queue.getStatus("private-diagnostic-attempt");
    expect(status?.error?.message).toBe(PRIVATE);
    const records = current.logs.read("job-error");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ event: "job-error", assetId: artifact.artifactId, jobType: type, errorCode: "OFFLINE" });
    expect(records[0]).not.toHaveProperty("error");
    expect(JSON.stringify(records)).not.toContain(PRIVATE);
    if (type === "semantic_index") expect(records[0]).toMatchObject({ detached: true });
  });

  it("keeps provider failure details in artifact state and explicit chat messages in chat history", async () => {
    const current = await open();
    const artifact = value(await current.artifacts.create("image", "private"));
    const lease = current.jobs.artifactWork.begin(artifact.artifactId, { kind: "generate", ownerKind: "job", durationMs: 60_000 });
    if (!lease) throw new Error("Could not acquire fixture lease");
    value(await current.jobs.pending.write({ artifactId: artifact.artifactId, taskId: "private-task", taskType: "alibaba_image" }, lease.ownerId));
    await failPendingTaskAndLog(current, artifact.artifactId, "private-task", { message: PRIVATE, failCode: PRIVATE });
    expect(value(current.jobs.failures.read(artifact.artifactId))).toMatchObject({ message: PRIVATE });
    expect(current.logs.read("job-error")).toEqual([expect.objectContaining({ assetId: artifact.artifactId, errorCode: "UNKNOWN" })]);
    expect(JSON.stringify(current.logs.read("job-error"))).not.toContain(PRIVATE);
    const lines = capture();
    const bookId = current.book.get().bookId;
    await withLogging(recordPromptDef(current), current).handler({ book_id: bookId, surface: "chat", prompt: PRIVATE });
    const result = await withLogging(listPromptHistoryDef(current), current).handler({ book_id: bookId, surface: "chat" });
    expect(result.content[0]?.text).toContain(PRIVATE);
    expect(lines.join("\n")).not.toContain(PRIVATE);
  });

  it("logs a reopened book by ID without its private name or path", async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-private-book-"));
    const libraryDir = join(root, "books");
    let books = new BookManager({ libraryDir });
    const lines = capture();
    try {
      const created = value(await books.create("private-book-title-credential"));
      await books.close();
      books = new BookManager({ libraryDir });
      await books.ready();
      expect(value(books.get(created.bookId)).engine.book.get().name).toBe("private-book-title-credential");
      expect(lines.some((line) => line.includes("book-open") && line.includes(created.bookId))).toBe(true);
      expect(lines.join("\n")).not.toContain("private-book-title-credential");
      expect(lines.join("\n")).not.toContain(root);
    } finally { await books.close(); }
  });

  it("routes owned runtime sinks through diagnostics and keeps name registration at trusted boundaries", async () => {
    const sourceRoot = import.meta.dirname;
    const violations: string[] = [];
    async function inspect(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { await inspect(path); continue; }
        if (!entry.name.endsWith(".ts") || /\.(test|probe)\.ts$/.test(entry.name)) continue;
        const file = relative(sourceRoot, path).replaceAll("\\", "/");
        const source = ts.createSourceFile(file, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
        function visit(node: ts.Node): void {
          if (ts.isCallExpression(node)) {
            const callee = node.expression.getText(source);
            const processOutputBoundary = file.startsWith("cli/");
            if (/^console\./.test(callee) && file !== "logger.ts" && !processOutputBoundary) violations.push(`${file}: console`);
            if (/\.logs\.append$/.test(callee) && !["diagnostics.ts", "tools/chat-history.ts"].includes(file)) violations.push(`${file}: persistent log`);
            if (/^process\.(stdout|stderr)\.write$/.test(callee) && !processOutputBoundary) violations.push(`${file}: process output`);
            if (callee === "registerDiagnosticName" && !["queue.ts", "tools/log-wrapper.ts"].includes(file)) violations.push(`${file}: name registration`);
            if (/^logger\./.test(callee) && !ts.isStringLiteral(node.arguments[0])) violations.push(`${file}: dynamic event`);
          }
          ts.forEachChild(node, visit);
        }
        visit(source);
      }
    }
    await inspect(sourceRoot);
    expect(violations).toEqual([]);
  });
});

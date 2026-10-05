import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { createEngine } from "videobook-engine";
import { z } from "zod";

import { configureLoggerForTests, resetLoggerForTests } from "../logger.js";
import { withLogging } from "./log-wrapper.js";

describe("MCP tool logging", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) {
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }
  });

  it("does not duplicate semantic activity recorded by the tool handler", async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-self-recorded-tool-"));
    const engine = createEngine({
      durableWrites: false,
      rootDir: root,
      initialBookName: "self-recorded-tool",
    });
    const wrapped = withLogging({
      name: "self_recorded_tool",
      description: "test",
      scope: "book",
      recordsOwnActivity: true,
      schema: { book_id: z.string() },
      handler: async () => {
        const recorded = await engine.book.rename("renamed-by-tool");
        if (!recorded.ok) throw new Error(recorded.error.message);
        return { content: [{ type: "text", text: "{}" }] };
      },
    }, engine);

    try {
      const before = engine.history.revisions().length;
      await wrapped.handler({ book_id: engine.book.get().bookId });
      const revisions = engine.history.revisions();
      expect(revisions).toHaveLength(before + 1);
      expect(revisions[0]?.operation).toBe("rename_book");
    } finally {
      engine.close();
    }
  });

  it.each(["returned", "thrown"])("keeps private %s errors available to callers without logging their content", async (mode) => {
    root = await mkdtemp(join(tmpdir(), "videobook-log-error-"));
    const engine = createEngine({
      durableWrites: false,
      rootDir: root,
      initialBookName: "log-error",
    });
    const privateText = "Private transcript, prompt and /private/book-path?token=credential-value";
    const result = { isError: true as const, content: [{ type: "text" as const, text: privateText }] };
    const failure = Object.assign(new Error(privateText), { code: "INVALID_INPUT", cause: result });
    const lines: string[] = [];
    configureLoggerForTests({
      level: "info",
      sink: {
        error: () => undefined,
        warn: () => undefined,
        info: (...args) => {
          lines.push(args.map(String).join(" "));
        },
        debug: () => undefined,
      },
    });
    try {
      const wrapped = withLogging({
        name: "failing_tool",
        description: "test",
        schema: { book_id: z.string() },
        handler: async () => {
          if (mode === "thrown") throw failure;
          return result;
        },
      }, engine);
      const pending = wrapped.handler({ book_id: engine.book.get().bookId, prompt: privateText });
      if (mode === "thrown") await expect(pending).rejects.toBe(failure);
      else await expect(pending).resolves.toBe(result);
    } finally {
      resetLoggerForTests();
      engine.close();
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[mcp\] /);
    const record = JSON.parse(lines[0].slice("[mcp] ".length));
    expect(record).toMatchObject({ event: "mcp", tool: "failing_tool", status: "error", durationMs: expect.any(Number) });
    if (mode === "thrown") expect(record.errorCode).toBe("INVALID_INPUT");
    expect(lines.join("\n")).not.toContain(privateText);
    expect(record).not.toHaveProperty("error");
    expect(record).not.toHaveProperty("content");
  });
});

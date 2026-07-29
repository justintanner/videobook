import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { createEngine } from "videobook-engine";
import { z } from "zod";

import { withLogging } from "./log-wrapper.js";

describe("MCP tool logging", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("does not duplicate semantic activity recorded by the tool handler", async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-self-recorded-tool-"));
    const engine = createEngine({
      rootDir: root,
      initialBookSlug: "self-recorded-tool",
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

    const before = engine.history.revisions().length;
    await wrapped.handler({ book_id: engine.book.get().bookId });
    const revisions = engine.history.revisions();
    expect(revisions).toHaveLength(before + 1);
    expect(revisions[0]?.operation).toBe("rename_book");
    engine.close();
  });
});

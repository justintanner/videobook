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

  it("does not duplicate activity recorded by the tool handler", async () => {
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
        const recorded = await engine.history.recordAction({
          operation: "self_recorded_tool",
          actor: "human",
        });
        if (!recorded.ok) throw new Error(recorded.error.message);
        return { content: [{ type: "text", text: "{}" }] };
      },
    }, engine);

    await wrapped.handler({ book_id: engine.book.get().bookId });
    const actions = engine.history.actions();
    expect(actions.ok).toBe(true);
    if (!actions.ok) throw new Error(actions.error.message);
    expect(actions.value.actions.map((action) => action.operation))
      .toEqual(["self_recorded_tool"]);
    engine.close();
  });
});

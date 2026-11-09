import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Har } from "@apicity/har";
import { appState } from "./app-state.js";
import { currentBookContext, withBookContext } from "./book-context.js";
import { closeEngineForTest, createEngineForTest } from "./engine.js";
import { flushHarCaptures } from "./har-capture.js";
import { harDirectory, writeHarSettings } from "./har-settings.js";
import { queue as appQueue, registerJobHandler, setEngineRoot } from "./queue.js";
import { testBudget } from "./test-budget.js";
import { createOpenAi } from "./usage-providers.js";

describe("usage attribution", () => {
  let root: string;
  let server: Server;
  let url: string;
  let responseIds: string[];
  let home: string | undefined;
  let override: string | undefined;
  let stored: unknown;
  const engineRef: { current?: ReturnType<typeof createEngineForTest> } = {};

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-usage-attribution-"));
    home = process.env.VIDEOBOOK_HOME;
    override = process.env.VIDEOBOOK_HAR_CAPTURE;
    process.env.VIDEOBOOK_HOME = root;
    delete process.env.VIDEOBOOK_HAR_CAPTURE;
    stored = await appState.get("harCapture");
    await appState.set("harCapture", null);
    responseIds = [];
    server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        const id = responseIds.shift() ?? `resp-${Date.now()}`;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id,
          status: "completed",
          output: [],
          usage: { input_tokens: 20, output_tokens: 10 },
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP address");
    url = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await flushHarCaptures();
    await appQueue.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (engineRef.current) closeEngineForTest(root, engineRef.current);
    engineRef.current = undefined;
    await appState.set("harCapture", stored);
    if (home === undefined) delete process.env.VIDEOBOOK_HOME;
    else process.env.VIDEOBOOK_HOME = home;
    if (override === undefined) delete process.env.VIDEOBOOK_HAR_CAPTURE;
    else process.env.VIDEOBOOK_HAR_CAPTURE = override;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  async function captures(): Promise<Har[]> {
    await flushHarCaptures();
    const index = await readFile(join(harDirectory(), "index.jsonl"), "utf8").catch(() => "");
    return Promise.all(index.trim().split("\n").filter(Boolean).map(async (line) => {
      const row = JSON.parse(line) as { file: string };
      return JSON.parse(await readFile(join(harDirectory(), row.file), "utf8")) as Har;
    }));
  }

  it("writes two rows for one notebook cell, sharing the job, each with an estimate and an actual", async () => {
    const engine = createEngineForTest(root);
    engineRef.current = engine;
    await setEngineRoot(root, engine);
    const bookId = engine.book.get().bookId;
    const notebook = await engine.notebooks.create("Main");
    if (!notebook.ok) throw new Error(notebook.error.message);
    const cell = engine.notebooks.createCell({ type: "prompt", slot: { row: 0, column: 0 }, label: "Attributed" });
    const inserted = await engine.notebooks.insertCell(notebook.value.id, cell);
    if (!inserted.ok) throw new Error(inserted.error.message);
    responseIds = ["cell-one", "cell-two", "chat-one", "unknown-one"];
    await writeHarSettings({ mode: "all" });
    let seenJobId = "";
    registerJobHandler("usage_attribution_probe", async () => {
      seenJobId = currentBookContext()?.jobId ?? "";
      const openai = createOpenAi({ apiKey: "test", baseURL: `${url}/v1` });
      await openai.post.v1.responses({ model: "gpt-4o", input: "one" });
      await openai.post.v1.responses({ model: "gpt-4o", input: "two" });
      return { ok: true };
    });

    const result = await appQueue.enqueueAndWait<{ ok: boolean }>("usage-attribution-probe", {
      type: "usage_attribution_probe",
      bookId,
      notebookId: notebook.value.id,
      cellId: cell.id,
    }, testBudget(15_000));
    expect(result.ok).toBe(true);
    expect(seenJobId).not.toBe("");

    const rows = engine.usage.recent(10).filter((entry) => entry.cellId === cell.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((entry) => entry.jobId === seenJobId && entry.notebookId === notebook.value.id)).toBe(true);
    expect(rows.map((entry) => entry.externalId).sort()).toEqual(["cell-one", "cell-two"]);
    expect(rows.every((entry) => typeof entry.estimateUsd === "number" && entry.estimateSource && entry.costUsd !== null
      && (entry.actualBasis === "stated" || entry.actualBasis === "derived"))).toBe(true);

    const files = await captures();
    const quoted = files.filter((file) => file.log._apicity?.endpoint === "v1.responses");
    expect(quoted).toHaveLength(2);
    expect(quoted.every((file) => typeof file.log._apicity?.estimate?.usd === "number" && file.log._apicity.estimate.usd >= 0)).toBe(true);

    const openai = createOpenAi({ apiKey: "test", baseURL: `${url}/v1` });
    await withBookContext({ bookId, engine, operation: "chat" }, () => openai.post.v1.responses({ model: "gpt-4o", input: "hello" }));
    const chat = engine.usage.find("openai", "chat-one");
    expect(chat).toMatchObject({ cellId: null, jobId: null, notebookId: null });
    expect(engine.usage.rollup({ cellId: cell.id }).totals.count).toBe(2);
    expect(engine.usage.rollup({ jobId: seenJobId }).totals.count).toBe(2);
    expect(engine.usage.rollup().totals.count).toBe(3);

    await withBookContext({ bookId, engine, operation: "chat" }, () => openai.post.v1.responses({ model: "not-a-real-model", input: "hello" }));
    expect(engine.usage.find("openai", "unknown-one")?.estimateUsd).toBeNull();
  });
});

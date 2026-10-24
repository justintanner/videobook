import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Engine, Generation, NotebookCell, NotebookDocument } from "videobook-engine";
import type { Har, HarPage } from "@apicity/har";
import { appState } from "../app-state.js";
import { withBookContext } from "../book-context.js";
import { closeEngineForTest, createEngineForTest } from "../engine.js";
import { flushHarCaptures, withHarCapture } from "../har-capture.js";
import { harDirectory, writeHarSettings } from "../har-settings.js";
import { generationPayloadDef } from "./generation-payload.js";
import { getGenerationHarDef } from "./get-generation-har.js";
import { listCellGenerationsDef, type ListCellGenerationsResponse } from "./list-cell-generations.js";

type HarStatus = { mode: string; hasCapture: boolean; captures: number; path: string | null; outcome: string | null };
type GenerationHarResult = {
  generationId: string;
  filename: string;
  captures: Array<{ path: string; endpoint: string; outcome: string; status: number | null }>;
  har: { log: Omit<Har["log"], "pages"> & { pages?: Array<HarPage & { _apicity?: { outcome: string } }> } };
};

const SECRETS = ["sk-live-secret-123", "cookie-secret-value", "sk-input-secret"];

describe("generation HAR captures", () => {
  let root: string;
  let bookRoot: string;
  let engine: Engine;
  let server: Server;
  let url: string;
  let home: string | undefined;
  let stored: unknown;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-generation-har-"));
    bookRoot = join(root, "book");
    home = process.env.VIDEOBOOK_HOME;
    process.env.VIDEOBOOK_HOME = root;
    stored = await appState.get("harCapture");
    await appState.set("harCapture", null);
    engine = createEngineForTest(bookRoot);
    await engine.ready;
    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.setHeader("set-cookie", "session=cookie-secret-value; HttpOnly");
        if (req.url?.startsWith("/fail")) {
          res.statusCode = 422;
          res.end(JSON.stringify({ error: "image_url is required" }));
          return;
        }
        res.end(JSON.stringify({ code: 200, data: { taskId: "task-1", state: "waiting" } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    url = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await flushHarCaptures();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeEngineForTest(bookRoot, engine);
    await appState.set("harCapture", stored);
    if (home === undefined) delete process.env.VIDEOBOOK_HOME;
    else process.env.VIDEOBOOK_HOME = home;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  function bookId(): string {
    return engine.book.get().bookId;
  }

  async function createAsset(label: string): Promise<string> {
    const created = await engine.artifacts.create("video", label);
    if (!created.ok) throw new Error(created.error.message);
    return created.value.artifactId;
  }

  async function createNotebookWithCell(): Promise<{ notebook: NotebookDocument; cell: NotebookCell }> {
    const created = await engine.notebooks.create("Captures");
    if (!created.ok) throw new Error(created.error.message);
    const cell = engine.notebooks.createCell({ type: "generate_video", slot: { row: 0, column: 0 }, prompt: "a fox", tool: "generate_video" });
    const inserted = await engine.notebooks.insertCell(created.value.id, cell);
    if (!inserted.ok) throw new Error(inserted.error.message);
    return { notebook: created.value, cell };
  }

  async function recordGeneration(notebook: NotebookDocument, cell: NotebookCell, providerArtifactId?: string): Promise<Generation> {
    const recorded = await engine.generations.record({
      notebookId: notebook.id, cellId: cell.id, tool: "generate_video", runId: "run-1",
      ...(providerArtifactId ? { providerArtifactId } : {}),
    });
    if (!recorded.ok) throw new Error(recorded.error.message);
    return recorded.value;
  }

  async function capture(
    context: { bookId?: string; artifactId?: string; attemptId?: string },
    path: "/ok" | "/fail",
    endpoint = "generation.submit",
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await withBookContext({ bookId: bookId(), engine, operation: "generate_media", ...context }, () =>
      withHarCapture({ provider: "kie", endpoint, input: { prompt: "a fox", apiKey: "sk-input-secret" } }, async (fetch) => {
        const response = await fetch(`${url}${path}`, {
          method: "POST",
          headers: { authorization: "Bearer sk-live-secret-123", "content-type": "application/json" },
          body: JSON.stringify({ prompt: "a fox" }),
        });
        const body: unknown = await response.json();
        if (!response.ok) throw Object.assign(new Error("image_url is required"), { status: response.status });
        return body;
      }, globalThis.fetch, extra)).catch(() => undefined);
    await flushHarCaptures();
  }

  async function inspect(assetId: string): Promise<HarStatus> {
    const result = await generationPayloadDef(engine).handler({ book_id: bookId(), asset_id: assetId });
    expect(result.isError).toBeUndefined();
    return (JSON.parse(result.content[0]!.text) as { har: HarStatus }).har;
  }

  async function generationHar(generationId: string): Promise<GenerationHarResult> {
    const result = await getGenerationHarDef(engine).handler({ book_id: bookId(), generation_id: generationId });
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    return JSON.parse(result.content[0]!.text) as GenerationHarResult;
  }

  it("reports a captured attempt's path and outcome, and none for other assets or books", async () => {
    await writeHarSettings({ mode: "failures" });
    const captured = await createAsset("captured");
    const plain = await createAsset("plain");
    await capture({ artifactId: captured, attemptId: captured }, "/fail");
    await capture({ artifactId: plain, attemptId: plain }, "/ok");
    await capture({ bookId: "01900000-0000-7000-8000-0000000000aa", artifactId: plain, attemptId: plain }, "/fail");

    const status = await inspect(captured);
    expect(status).toMatchObject({ mode: "failures", hasCapture: true, captures: 1, outcome: "provider_error" });
    expect(status.path?.startsWith(harDirectory())).toBe(true);
    const saved = JSON.parse(await readFile(status.path!, "utf8")) as Har;
    expect(saved.log._apicity?.context).toMatchObject({ bookId: bookId(), artifactId: captured });
    expect(await inspect(plain)).toEqual({ mode: "failures", hasCapture: false, captures: 0, path: null, outcome: null });
  });

  it("falls back to the provider task id kept in the provider-task metadata", async () => {
    await writeHarSettings({ mode: "all" });
    const asset = await createAsset("polled");
    const written = await engine.metadata.artifacts.write(asset, "provider-task", {
      taskId: "task-77", taskType: "media_kie", createdAt: Date.now(), meta: {},
    });
    expect(written.ok).toBe(true);
    await capture({}, "/ok", "get.api.v1.jobs.recordInfo", { providerTaskId: "task-77" });
    await capture({}, "/ok", "get.api.v1.jobs.recordInfo", { providerTaskId: "task-78" });

    expect(await inspect(asset)).toMatchObject({ mode: "all", hasCapture: true, captures: 1, outcome: "ok" });
  });

  it("returns one scrubbed HAR per attempt, by asset id or attempt id", async () => {
    await writeHarSettings({ mode: "all" });
    const { notebook, cell } = await createNotebookWithCell();
    const asset = await createAsset("generated");
    const generation = await recordGeneration(notebook, cell, asset);
    await capture({ artifactId: asset, attemptId: generation.generationId }, "/ok");
    await capture({ artifactId: asset, attemptId: generation.generationId }, "/fail", "get.api.v1.jobs.recordInfo", { providerTaskId: "task-1" });

    const byAsset = await generationHar(asset);
    const byAttempt = await generationHar(generation.generationId);
    expect(byAttempt.har.log.pages).toEqual(byAsset.har.log.pages);
    expect(byAttempt.har.log.entries).toEqual(byAsset.har.log.entries);
    expect(byAsset.filename).toBe(`videobook-generation-${asset}.har`);
    expect(byAsset.captures.map((item) => [item.endpoint, item.outcome, item.status]))
      .toEqual([["generation.submit", "ok", 200], ["get.api.v1.jobs.recordInfo", "provider_error", 422]]);
    const pages = byAsset.har.log.pages ?? [];
    expect(pages.map((page) => page._apicity?.outcome)).toEqual(["ok", "provider_error"]);
    expect(byAsset.har.log.entries.map((entry) => entry.pageref)).toEqual(pages.map((page) => page.id));
    expect(byAsset.har.log.entries.map((entry) => entry.response.status)).toEqual([200, 422]);
    const text = JSON.stringify(byAsset);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(text).toContain("image_url is required");
  });

  it("returns a single capture as written and explains a missing one", async () => {
    await writeHarSettings({ mode: "failures" });
    const asset = await createAsset("single");
    await capture({ artifactId: asset }, "/fail");

    const { captures, har } = await generationHar(asset);
    expect(captures).toHaveLength(1);
    expect(har).toEqual(JSON.parse(await readFile(captures[0]!.path, "utf8")));
    expect(har.log.pages).toBeUndefined();
    expect(har.log._apicity).toMatchObject({ provider: "kie", endpoint: "generation.submit", outcome: "provider_error" });
    for (const secret of SECRETS) expect(JSON.stringify(har)).not.toContain(secret);

    await writeHarSettings({ mode: "off" });
    const missing = await getGenerationHarDef(engine).handler({ book_id: bookId(), generation_id: await createAsset("none") });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain("Provider capture is off");
  });

  it("marks captured attempts in list_cell_generations", async () => {
    await writeHarSettings({ mode: "failures" });
    const { notebook, cell } = await createNotebookWithCell();
    const asset = await createAsset("listed");
    const captured = await recordGeneration(notebook, cell, asset);
    const plain = await recordGeneration(notebook, cell);
    await capture({ artifactId: asset, attemptId: captured.generationId }, "/fail");

    const result = await listCellGenerationsDef(engine).handler({ book_id: bookId(), notebook_id: notebook.id, cell_id: cell.id });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text) as ListCellGenerationsResponse;
    expect(data.harMode).toBe("failures");
    const byAttempt = new Map(data.attempts.map((attempt) => [attempt.attemptId, attempt.har]));
    expect(byAttempt.get(captured.generationId)).toMatchObject({ hasCapture: true, captures: 1, outcome: "provider_error" });
    expect(byAttempt.get(plain.generationId)).toMatchObject({ hasCapture: false, captures: 0 });
  });
});

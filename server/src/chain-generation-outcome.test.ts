import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { preflightAndAccept, waitForChainRun, type ChainRunRecord } from "./chain-executor.js";
import { createEngineForTest } from "./engine.js";
import { configureProviderEndpoints } from "./media/endpoints.js";
import { configureProviderPollDriverForTests, resetProviderPollDriverForTests } from "./queue.js";
import { testBudget } from "./test-budget.js";
import { createTestClient } from "./test-client.js";
import { getAllToolDefs } from "./tools/index.js";

const ENDPOINT = "openai/gpt-image-2.6/flare/text-to-image";
const REFUSAL = "Request blocked by the content policy";

function sendJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

describe("notebook chain generation outcome", () => {
  let server: Server;
  let baseURL: string;
  let png: Buffer;
  let refuse: boolean;
  let requests = 0;
  let root: string;
  let engine: Engine;
  let client: Client;
  let bookId: string;
  let notebookId: string;
  let restoreEndpoints: () => void;
  const savedEnv = new Map<string, string | undefined>();

  beforeAll(async () => {
    png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#c84f2f" } }).png().toBuffer();
    server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
        if (request.method === "POST" && path === `/${ENDPOINT}`) return sendJson(response, { request_id: `outcome-${++requests}`, status: "IN_QUEUE" });
        if (/^\/openai\/gpt-image-2\.6\/requests\/[^/]+\/status$/u.test(path)) return sendJson(response, refuse ? { status: "COMPLETED", error: REFUSAL } : { status: "COMPLETED" });
        if (/^\/openai\/gpt-image-2\.6\/requests\/[^/]+$/u.test(path)) return sendJson(response, { images: [{ url: `${baseURL}/files/fox.png`, content_type: "image/png" }] });
        if (path === "/files/fox.png") {
          response.writeHead(200, { "content-type": "image/png" });
          response.end(png);
          return;
        }
        response.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    refuse = false;
    for (const [key, value] of [["FAL_API_KEY", "local-fal-key"], ["VIDEOBOOK_HAR_CAPTURE", "off"]] as const) {
      savedEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
    restoreEndpoints = configureProviderEndpoints({ falQueueBaseURL: baseURL });
    configureProviderPollDriverForTests({ intervalMs: 50 });
    root = await mkdtemp(join(tmpdir(), "videobook-chain-outcome-"));
    engine = createEngineForTest(join(root, "book"));
    client = await createTestClient(join(root, "book"));
    bookId = engine.book.get().bookId;
    const notebook = await engine.notebooks.create("Outcomes");
    if (!notebook.ok) throw new Error(notebook.error.message);
    notebookId = notebook.value.id;
  });

  afterEach(async () => {
    await client.close();
    resetProviderPollDriverForTests();
    restoreEndpoints();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  async function generateInChain(): Promise<ChainRunRecord> {
    const defs = getAllToolDefs(engine);
    const accepted = await preflightAndAccept({
      action: "run", version: 1, book_id: bookId, notebook_id: notebookId, request_id: `outcome-${requests}-${Date.now()}`,
      steps: [{ id: "image", tool: "generate_image", params: { model: `fal:${ENDPOINT}`, prompt: "a red fox in the snow", options: { image_size: "square_hd" } } }],
    }, {
      engine, bookId, notebookId,
      toolSchemas: new Map(defs.map((def) => [def.name, def.schema])),
      autoApplyTools: new Set(),
      effectForTool: () => "generation",
    }, (name) => defs.find((def) => def.name === name), { actor: "chat" });
    return waitForChainRun(engine, accepted.chainId, testBudget(60_000));
  }

  it("fails the step and the run with the provider's message when the generation fails", async () => {
    refuse = true;
    const run = await generateInChain();
    expect(run).toMatchObject({ status: "failed", error: expect.stringContaining(REFUSAL) });
    expect(run.steps[0]).toMatchObject({ status: "failed", error: expect.stringContaining(REFUSAL) });
    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    const failedCells = Object.values(notebook.value.execution ?? {})
      .filter((execution) => execution.runId === `${run.chainId}:image` && execution.status === "error");
    expect(failedCells.map((execution) => execution.error)).toEqual([expect.stringContaining(REFUSAL)]);
  });

  it("completes the step with the generated image when the provider succeeds", async () => {
    const run = await generateInChain();
    expect(run.status, run.error ?? "").toBe("completed");
    expect(run.steps[0]).toMatchObject({ status: "completed", error: null });
    const manifest = await engine.files.manifest(String(run.steps[0]!.outputs?.asset_id));
    expect(manifest.ok && manifest.value.files.map((file) => file.name)).toContain("original.png");
  });
});

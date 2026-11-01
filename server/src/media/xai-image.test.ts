import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import { createEngine, type Engine } from "videobook-engine";
import { createTestClient } from "../test-client.js";
import { createEngineForTest } from "../engine.js";
import { pauseBookQueueForTests, resumeBookQueueForTests, waitForJob } from "../queue.js";
import { runFfmpeg } from "../ffmpeg.js";
import { getAllToolDefs } from "../tools/index.js";
import { configureProviderEndpoints } from "./endpoints.js";
import { testBudget } from "../test-budget.js";

const MODEL = "xai:grok-imagine-image-2.0";
const SOURCE = "https://example.test/source.png";

interface Recorded {
  method: string;
  path: string;
  authorization: string | undefined;
  body: string;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

describe("xAI image generation", () => {
  let server: Server;
  let baseURL: string;
  let fixtures: string;
  let png: Buffer;
  let recorded: Recorded[];
  let root: string;
  let engine: Engine;
  let client: Client;
  let originalKey: string | undefined;
  let restoreEndpoints: () => void;

  function route(method: string, path: string, response: ServerResponse): void {
    if (method === "POST" && (path === "/images/generations" || path === "/images/edits")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ created: 1, model: "grok-imagine-image-2.0", data: [{ url: `${baseURL}/out.png`, mime_type: "image/png" }] }));
      return;
    }
    if (method === "GET" && path === "/out.png") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(png);
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Not Found" }));
  }

  beforeAll(async () => {
    fixtures = await mkdtemp(join(tmpdir(), "videobook-xai-image-fixtures-"));
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=red:s=64x64:d=1", "-frames:v", "1", join(fixtures, "out.png")]);
    png = await readFile(join(fixtures, "out.png"));
    server = createServer((incoming, response) => {
      void readBody(incoming).then((body) => {
        recorded.push({ method: incoming.method ?? "", path: incoming.url ?? "", authorization: incoming.headers.authorization, body });
        route(incoming.method ?? "", incoming.url ?? "", response);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(fixtures, { recursive: true, force: true });
  });

  beforeEach(async () => {
    recorded = [];
    root = await mkdtemp(join(tmpdir(), "videobook-xai-image-"));
    engine = createEngineForTest(root);
    client = await createTestClient(root);
    await pauseBookQueueForTests(engine.book.get().bookId);
    originalKey = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "local-xai-key";
    restoreEndpoints = configureProviderEndpoints({ xaiBaseURL: baseURL });
  });

  afterEach(async () => {
    restoreEndpoints();
    await client.close();
    if (originalKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = originalKey;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
    return (result.content as Array<{ text: string }>)[0]!.text;
  }

  async function generated(args: Record<string, unknown>): Promise<string> {
    const bookId = engine.book.get().bookId;
    const result = await client.callTool({ name: "generate_image", arguments: { book_id: bookId, model: MODEL, ...args } });
    expect(result.isError, toolText(result)).toBeFalsy();
    const enqueued = JSON.parse(toolText(result)) as { asset_id: string; job_id: string };
    await resumeBookQueueForTests(bookId);
    await waitForJob(enqueued.job_id, testBudget(30_000));
    return enqueued.asset_id;
  }

  async function storedImage(assetId: string): Promise<Buffer | null> {
    const read = await engine.files.read(assetId, "original.png");
    return read.ok ? Buffer.from(read.value) : null;
  }

  it("generates a Grok Imagine Image 2.0 picture through v1/images/generations", async () => {
    const assetId = await generated({ prompt: "a red kite over the sea", options: { quality: "low" } });
    const call = recorded.find((entry) => entry.method === "POST")!;
    expect(call.path).toBe("/images/generations");
    expect(call.authorization).toBe("Bearer local-xai-key");
    expect(JSON.parse(call.body)).toEqual({
      prompt: "a red kite over the sea",
      model: "grok-imagine-image-2.0",
      aspect_ratio: "9:16",
      resolution: "2k",
      quality: "low",
    });
    expect(await storedImage(assetId)).toEqual(png);
  });

  it("sends connected images to v1/images/edits", async () => {
    await generated({ prompt: "make @image1 blue", refs: { image: [SOURCE] } });
    const call = recorded.find((entry) => entry.method === "POST")!;
    expect(call.path).toBe("/images/edits");
    expect(JSON.parse(call.body)).toMatchObject({
      model: "grok-imagine-image-2.0",
      images: [{ url: SOURCE }],
    });
  });
});

describe("xAI notebook generation previews", () => {
  let rootDir: string;
  let engine: Engine;
  let notebookId: string;
  let imageCellId: string;

  interface Draft {
    type: "generate_image" | "generate_video";
    model: string;
    operation: string;
    prompt: string;
  }

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-xai-preview-"));
    engine = createEngine({ rootDir, initialBookName: "xai-previews", durableWrites: false });
    await engine.ready;
    const notebook = await engine.notebooks.create("Main");
    if (!notebook.ok) throw new Error(notebook.error.message);
    const artifact = await engine.artifacts.create("image", "source");
    if (!artifact.ok) throw new Error(artifact.error.message);
    const image = engine.notebooks.createCell({ type: "image", slot: { row: 0, column: 0 }, outputArtifactId: artifact.value.artifactId });
    const written = await engine.notebooks.write({ ...notebook.value, cells: [image] });
    if (!written.ok) throw new Error(written.error.message);
    notebookId = notebook.value.id;
    imageCellId = image.id;
  });

  afterEach(async () => {
    engine.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function preview(draft: Draft, connectImage = false): Promise<{ provider_path?: string; payload: Record<string, unknown> }> {
    const tool = getAllToolDefs(engine).find((definition) => definition.name === "preview_notebook_generation")!;
    const slot = { row: 1, column: 0 };
    const result = await tool.handler({
      book_id: engine.book.get().bookId,
      notebook_id: notebookId,
      cell_id: engine.notebooks.createCell({ type: draft.type, slot }).id,
      draft: { ...draft, slot, provider: "xai", tool: draft.type },
      connections: connectImage ? [{ source_cell_id: imageCellId, target_input: "image" }] : [],
    });
    const text = result.content[0]!.text!;
    expect(result.isError, text).not.toBe(true);
    return JSON.parse(text) as { provider_path?: string; payload: Record<string, unknown> };
  }

  it("names v1/images/generations for Grok Imagine Image 2.0 without connected images", async () => {
    const generation = await preview({ type: "generate_image", model: MODEL, operation: "text_to_image", prompt: "a red kite over the sea" });
    expect(generation.provider_path).toBe("xai.post.v1.images.generations(request, { otp })");
    expect(generation.payload).not.toHaveProperty("images");
  });

  it("names v1/images/edits for Grok Imagine Image 2.0 with a connected image", async () => {
    const edit = await preview({ type: "generate_image", model: MODEL, operation: "edit_image", prompt: "make @image1 blue" }, true);
    expect(edit.provider_path).toBe("xai.post.v1.images.edits(request, { otp })");
    expect(edit.payload).toMatchObject({ model: "grok-imagine-image-2.0", images: [{ url: expect.any(String) }] });
  });

  it("keeps v1/videos/generations for Grok Imagine Video", async () => {
    const video = await preview({ type: "generate_video", model: "xai:grok-imagine-video-1.5", operation: "text_to_video", prompt: "a kite drifting over the sea" });
    expect(video.provider_path).toBe("xai.post.v1.videos.generations(request, { otp })");
  });
});

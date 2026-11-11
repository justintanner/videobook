import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine, Job } from "videobook-engine";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEngineForTest } from "../engine.js";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import { storeFrameRegions } from "../frame-regions.js";
import type { GraphicsDocument } from "../graphics/model.js";
import { configureProviderEndpoints } from "../media/endpoints.js";
import { registerMediaProbe } from "../notebook-media-ops.js";
import { toolSpendsMoney } from "../paid-tools.js";
import { createTestClient } from "../test-client.js";

const execFileAsync = promisify(execFile);
const WIDTH = 360;
const HEIGHT = 640;
const FACE = { kind: "face" as const, confidence: 0.9, x: 0.05, y: 0.7, width: 0.25, height: 0.2 };
const OVER_FACE = { x: 18, y: 448, width: 140, height: 100 };
const COLORS = ["gray", "red", "green", "blue", "yellow", "purple", "orange", "white"];

type TextContent = Array<{ type: string; text: string }>;
type ContentPart = { type: string; text?: string; image_url?: string };
type ModelRequest = { model: string; input: Array<{ content: ContentPart[] }>; text: { format: { name: string } } };
type Read = { revision: string; saved: boolean; document: GraphicsDocument; source: { source_hash: string }; regions: Array<{ time: number; regions: unknown[] }> };
type Placement = {
  asset_id: string;
  layer_id: string;
  window: { start: number; end: number };
  times: number[];
  unchecked_times: number[];
  covers: Array<{ kind: string; time: number }>;
  clear_spot: { position: { anchor: string; x: number; y: number; space: string }; moved: boolean; covers: unknown[] } | null;
  detected?: number;
  regions?: Array<{ time: number; regions: unknown[] }>;
};
type Failure = { status: string; message: string; layer_id?: string };

function responsesBody(text: string): string {
  return JSON.stringify({
    id: "resp_graphics_regions", object: "response", created_at: 0, status: "completed", model: "gpt-5.6-sol",
    output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
    instructions: null, previous_response_id: null, temperature: null, top_p: null, max_output_tokens: null,
    store: false, tools: [], reasoning: null, text: { format: { type: "text" } },
    usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 }, error: null, incomplete_details: null, metadata: {},
  });
}

function cueIds(request: ModelRequest): string[] {
  return request.input.flatMap((message) => message.content)
    .flatMap((part) => (part.type === "input_text" && part.text?.startsWith("cue_id=") ? [part.text.slice(7).split(";")[0]] : []));
}

describe("video_graphics placement", () => {
  let client: Client;
  let engine: Engine;
  let tempDir: string;
  let model: Server;
  let captured: ModelRequest[] = [];
  let restoreEndpoints: () => void = () => undefined;
  let clips = 0;
  const bookId = "video-graphics-placement-book";

  async function video(): Promise<string> {
    clips += 1;
    const output = join(tempDir, `clip-${clips}.mp4`);
    await execFileAsync(FFMPEG, [
      "-y", "-f", "lavfi", "-i", `color=c=${COLORS[clips % COLORS.length]}:s=${WIDTH}x${HEIGHT}:r=24:d=2`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", output,
    ]);
    const created = await engine.artifacts.create("video", "red light");
    if (!created.ok) throw new Error(created.error.message);
    const artifactId = created.value.artifactId;
    const written = await engine.files.write(artifactId, "original.mp4", await readFile(output));
    if (!written.ok) throw new Error(written.error.message);
    const manifest = await engine.files.manifest(artifactId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    await registerMediaProbe(engine, artifactId, "original.mp4", await probeVideo(join(manifest.value.path, "original.mp4")));
    return artifactId;
  }

  async function call(args: Record<string, unknown>): Promise<{ error: boolean; body: unknown; text: string }> {
    const result = await client.callTool({ name: "video_graphics", arguments: { book_id: bookId, ...args } });
    const text = (result.content as TextContent)[0].text;
    try {
      return { error: result.isError === true, body: JSON.parse(text), text };
    } catch {
      return { error: result.isError === true, body: null, text };
    }
  }

  async function ok<T>(args: Record<string, unknown>): Promise<T> {
    const result = await call(args);
    if (result.error) throw new Error(result.text);
    return result.body as T;
  }

  async function fails(args: Record<string, unknown>): Promise<Failure> {
    const result = await call(args);
    expect(result.error, result.text).toBe(true);
    return result.body as Failure;
  }

  function layerId(read: Read, kind: string, slot?: string): string {
    const layer = read.document.layers.find((entry) => entry.kind === kind && (!slot || (entry.kind === "text" && entry.items.some((item) => item.slot === slot))));
    if (!layer) throw new Error(`no ${kind} layer`);
    return layer.id;
  }

  function regionJobs(assetId: string): Job[] {
    return engine.jobs.queue.list({ type: "graphics_regions", limit: 100 }).filter((job) => job.payload.assetId === assetId);
  }

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-graphics-placement-"));
    client = await createTestClient(tempDir);
    engine = createEngineForTest(tempDir);
    await client.callTool({ name: "create_project", arguments: { book_id: bookId } });
    model = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ModelRequest;
        captured.push(body);
        const frames = cueIds(body).map((cueId, index) => ({
          cue_id: cueId,
          occupied_regions: index === 0 ? [{ kind: "face", confidence: 0.9, x: 50, y: 700, width: 250, height: 200 }] : [],
        }));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(responsesBody(JSON.stringify({ frames })));
      });
    });
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  });

  beforeEach(() => {
    captured = [];
    process.env.OPENAI_API_KEY = "offline-openai-key";
    restoreEndpoints = configureProviderEndpoints({ openaiBaseURL: `http://127.0.0.1:${(model.address() as AddressInfo).port}` });
  });

  afterEach(() => {
    restoreEndpoints();
    delete process.env.OPENAI_API_KEY;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      model.closeAllConnections();
      model.close(() => resolve());
    });
    await client?.close();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("answers from cached faces and text for free: what a box covers and the clearest anchor", async () => {
    const assetId = await video();
    const fresh = await ok<Read>({ asset_id: assetId });
    expect(fresh.regions).toEqual([]);
    storeFrameRegions(engine, assetId, fresh.source.source_hash, [{ time: 0.5, regions: [FACE] }, { time: 1.5, regions: [] }]);
    const title = layerId(fresh, "text", "headline");

    const placement = await ok<Placement>({ asset_id: assetId, op: "check_placement", layer_id: title, box: OVER_FACE });

    expect(placement).toMatchObject({
      asset_id: assetId,
      layer_id: title,
      window: { start: 0, end: 2 },
      times: [0.5, 1.5],
      unchecked_times: [],
      covers: [{ kind: "face", time: 0.5 }],
      clear_spot: { position: { anchor: "bottom-right", x: 1, y: 1, space: "safe" }, moved: true, covers: [] },
    });
    const clear = await ok<Placement>({ asset_id: assetId, op: "check_placement", layer_id: title, box: { x: 200, y: 448, width: 140, height: 100 } });
    expect(clear).toMatchObject({ covers: [], clear_spot: { moved: false, covers: [] } });
    const read = await ok<Read>({ asset_id: assetId });
    expect(read.regions).toEqual([{ time: 0.5, regions: [FACE] }, { time: 1.5, regions: [] }]);
    expect(read.saved).toBe(false);
    expect(captured).toEqual([]);
    expect(regionJobs(assetId)).toEqual([]);
  });

  it("says which frames are unchecked, and detect_regions finds them once in a queued vision call", async () => {
    const assetId = await video();
    const fresh = await ok<Read>({ asset_id: assetId });
    const title = layerId(fresh, "text", "headline");
    const unchecked = await ok<Placement>({ asset_id: assetId, op: "check_placement", layer_id: title, box: OVER_FACE });
    expect(unchecked).toMatchObject({ times: [0.5, 1.5], unchecked_times: [0.5, 1.5], covers: [], clear_spot: null });

    const detected = await ok<Placement>({ asset_id: assetId, op: "detect_regions", layer_id: title, box: OVER_FACE });

    expect(detected).toMatchObject({
      detected: 2,
      unchecked_times: [],
      covers: [{ kind: "face", time: 0.5 }],
      clear_spot: { moved: true, covers: [] },
    });
    expect(detected.regions).toEqual([
      { time: 0.5, regions: [{ kind: "face", confidence: 0.9, x: 0.05, y: 0.7, width: 0.25, height: 0.2 }] },
      { time: 1.5, regions: [] },
    ]);
    expect(captured).toHaveLength(1);
    expect(captured[0].text.format.name).toBe("frame_regions");
    expect(cueIds(captured[0])).toEqual(["f0", "f1"]);
    expect(captured[0].input[0].content.filter((part) => part.type === "input_image")).toHaveLength(2);
    expect(regionJobs(assetId)).toEqual([expect.objectContaining({ state: "done", artifactId: null })]);

    const again = await ok<Placement>({ asset_id: assetId, op: "detect_regions", layer_id: title, box: OVER_FACE });
    expect(again).toMatchObject({ detected: 0, unchecked_times: [] });
    expect(captured).toHaveLength(1);
    expect(regionJobs(assetId)).toHaveLength(1);
  });

  it("checks only the layer's own window", async () => {
    const assetId = await video();
    const fresh = await ok<Read>({ asset_id: assetId });
    const title = layerId(fresh, "text", "headline");
    const saved = await ok<{ revision: string }>({ asset_id: assetId, op: "update", expected_revision: fresh.revision, edits: [{ op: "set_timing", layer_id: title, timing: { start: 1, end: 2 } }] });
    expect(saved.revision).not.toBe(fresh.revision);
    storeFrameRegions(engine, assetId, fresh.source.source_hash, [{ time: 0.5, regions: [FACE] }, { time: 1.5, regions: [] }]);
    const placement = await ok<Placement>({ asset_id: assetId, op: "check_placement", layer_id: title, box: OVER_FACE });
    expect(placement).toMatchObject({ window: { start: 1, end: 2 }, times: [1.5], unchecked_times: [], covers: [], clear_spot: { moved: false } });
  });

  it("refuses what it cannot check with a structured error, no job and no model call", async () => {
    const assetId = await video();
    const fresh = await ok<Read>({ asset_id: assetId });
    const title = layerId(fresh, "text", "headline");
    const shade = layerId(fresh, "scrim");
    expect(await fails({ asset_id: assetId, op: "check_placement", box: OVER_FACE })).toMatchObject({ status: "invalid", message: expect.stringMatching(/needs layer_id/u) });
    expect(await fails({ asset_id: assetId, op: "check_placement", layer_id: title })).toMatchObject({ status: "invalid", message: expect.stringMatching(/needs box/u) });
    expect(await fails({ asset_id: assetId, op: "check_placement", layer_id: "l99", box: OVER_FACE })).toMatchObject({ status: "invalid", layer_id: "l99" });
    expect(await fails({ asset_id: assetId, op: "detect_regions", layer_id: shade })).toMatchObject({ status: "invalid", message: expect.stringMatching(/shade/u) });
    delete process.env.OPENAI_API_KEY;
    expect(await fails({ asset_id: assetId, op: "detect_regions", layer_id: title, box: OVER_FACE })).toMatchObject({ status: "not_ready", message: expect.stringMatching(/OPENAI_API_KEY/u) });
    expect(captured).toEqual([]);
    expect(regionJobs(assetId)).toEqual([]);
  });

  it("is billable only when it detects", () => {
    expect(toolSpendsMoney("video_graphics", { op: "detect_regions" })).toBe(true);
    expect(toolSpendsMoney("video_graphics", { op: "check_placement" })).toBe(false);
    expect(toolSpendsMoney("video_graphics", { op: "suggest" })).toBe(true);
    expect(toolSpendsMoney("video_graphics", { op: "get" })).toBe(false);
  });
});

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import type { GraphicsDocument } from "../graphics/model.js";
import { configureProviderEndpoints } from "../media/endpoints.js";
import { registerMediaProbe } from "../notebook-media-ops.js";
import { toolSpendsMoney } from "../paid-tools.js";
import { createTestClient } from "../test-client.js";
import { PLAIN_TRANSCRIPT_FILE } from "../transcript-projection.js";
import { VIDEO_ANALYSIS_FILE } from "../video-analysis-projection.js";

const execFileAsync = promisify(execFile);
const THAI_TITLE = "ติดไฟแดงยังไงให้เท่ได้ขนาดนี้";
const ENGLISH_TITLE = "How can you look this cool at a red light?";
const DOWNLOAD = {
  origin: "download",
  source_url: "https://www.tiktok.com/@pomkondeena/video/7432100000000000000",
  webpage_url: "https://www.tiktok.com/@pomkondeena/video/7432100000000000000",
  platform: "TikTok",
  uploader: "pomkondeena",
  title: "Pink umbrella rider at a red light",
  description: "When the rain will not stop you #bangkok #rain",
};
const ANALYSIS = {
  summary: "A man waits at a red light on a scooter in heavy rain, holding a pink umbrella.",
  mood: "playful",
  setting: "city street",
  subjects: ["rider", "pink umbrella"],
  actions: ["waiting"],
  tags: ["rain", "scooter"],
  scenes: [{ timestamp: 0, description: "The rider stops at the light", tags: [] }],
  textOnScreen: [],
};

type TextContent = Array<{ type: string; text: string }>;
type OptionsSchema = { minItems: number; maxItems: number };
type ModelRequest = {
  model: string;
  input: Array<{ content: string }>;
  text: { format: { type: string; name: string; strict: boolean; schema: { properties: { options: OptionsSchema } } } };
};
type Captured = { url: string; body: ModelRequest };
type Suggestions = {
  asset_id: string;
  kind: string;
  slot: string;
  language: string;
  text: string | null;
  options: string[];
  model: string;
  context: { analysis: boolean; transcript: boolean; download: boolean } | null;
};
type Failure = { status: string; message: string };
type Read = { revision: string; document: GraphicsDocument };

function responsesBody(text: string): string {
  return JSON.stringify({
    id: "resp_graphics_suggest", object: "response", created_at: 0, status: "completed", model: "gpt-6-astra",
    output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
    instructions: null, previous_response_id: null, temperature: null, top_p: null, max_output_tokens: null,
    store: false, tools: [], reasoning: null, text: { format: { type: "text" } },
    usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 }, error: null, incomplete_details: null, metadata: {},
  });
}

describe("video_graphics suggest", () => {
  let client: Client;
  let engine: Engine;
  let tempDir: string;
  let model: Server;
  let captured: Captured[] = [];
  let reply: unknown = { options: [] };
  let restoreEndpoints: () => void = () => undefined;
  let clips = 0;
  const bookId = "video-graphics-suggest-book";

  async function video(original?: Record<string, unknown>): Promise<string> {
    clips += 1;
    const output = join(tempDir, `clip-${clips}.mp4`);
    await execFileAsync(FFMPEG, [
      "-y", "-f", "lavfi", "-i", "color=c=gray:s=360x640:r=24:d=2",
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
    if (original) {
      const saved = await engine.metadata.artifacts.write(artifactId, "original", original);
      if (!saved.ok) throw new Error(saved.error.message);
    }
    return artifactId;
  }

  async function sidecar(artifactId: string, name: string, value: unknown): Promise<void> {
    const written = await engine.files.write(artifactId, name, Buffer.from(JSON.stringify(value)));
    if (!written.ok) throw new Error(written.error.message);
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

  function suggestJobs(assetId: string): Job[] {
    return engine.jobs.queue.list({ type: "suggest_graphics", limit: 100 }).filter((job) => job.payload.assetId === assetId);
  }

  function prompt(index: number): string {
    return captured[index].body.input[0].content;
  }

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-graphics-suggest-"));
    client = await createTestClient(tempDir);
    engine = createEngineForTest(tempDir);
    await client.callTool({ name: "create_project", arguments: { book_id: bookId } });
    model = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        captured.push({ url: request.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as ModelRequest });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(responsesBody(JSON.stringify(reply)));
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

  it("writes Thai headlines from the analysis, transcript and download text in one queued model call and saves nothing", async () => {
    const assetId = await video(DOWNLOAD);
    await sidecar(assetId, VIDEO_ANALYSIS_FILE, ANALYSIS);
    await sidecar(assetId, PLAIN_TRANSCRIPT_FILE, { text: "Nothing stops me, not even this rain at the red light." });
    reply = {
      options: ["“ฝนตกก็ไม่หยุดเท่”", "ร่มชมพูกลางไฟแดง", "ร่มชมพูกลางไฟแดง", " ", "x".repeat(281), "ไฟแดงนี้ของเรา", "ใครจะเท่\nเท่านี้", "ขี่ฝ่าฝนแบบมีสไตล์", "ฝนแค่นี้สบายมาก"],
    };

    const suggested = await ok<Suggestions>({ asset_id: assetId, op: "suggest" });

    expect(suggested).toEqual({
      asset_id: assetId,
      kind: "headline",
      slot: "headline",
      language: "th",
      text: null,
      options: ["ฝนตกก็ไม่หยุดเท่", "ร่มชมพูกลางไฟแดง", "ไฟแดงนี้ของเรา", "ใครจะเท่ เท่านี้", "ขี่ฝ่าฝนแบบมีสไตล์"],
      model: "gpt-6-astra",
      context: { analysis: true, transcript: true, download: true },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("/responses");
    expect(captured[0].body.model).toBe("gpt-6-astra");
    expect(captured[0].body.text.format).toMatchObject({ type: "json_schema", name: "graphics_suggestions", strict: true });
    expect(captured[0].body.text.format.schema.properties.options).toMatchObject({ minItems: 3, maxItems: 5 });
    expect(prompt(0)).toContain("Write 5 headline options");
    expect(prompt(0)).toContain("in Thai, natural and conversational");
    expect(prompt(0)).toContain("No hashtags, no emoji and no quotation marks.");
    expect(prompt(0)).toContain("holding a pink umbrella");
    expect(prompt(0)).toContain("Nothing stops me, not even this rain at the red light.");
    expect(prompt(0)).toContain("Title: Pink umbrella rider at a red light");
    expect(prompt(0)).toContain("Description: When the rain will not stop you #bangkok #rain");
    expect(suggestJobs(assetId)).toEqual([expect.objectContaining({ state: "done", artifactId: null })]);
    expect(engine.settings.get(`graphics.draft.${assetId}`)).toBeNull();

    reply = { options: ["'Don't stop me now'", "\"Wow\" says the rider, \"cool\"", "Too cool for the rain"] };
    const english = await ok<Suggestions>({ asset_id: assetId, op: "suggest", language: "en" });
    expect(english).toMatchObject({ language: "en", options: ["Don't stop me now", "\"Wow\" says the rider, \"cool\"", "Too cool for the rain"] });
    expect(prompt(1)).toContain("Write every headline in English.");
  });

  it("translates the saved headline into English, and an English headline into Thai, with no video context", async () => {
    const assetId = await video();
    const fresh = await ok<Read>({ asset_id: assetId });
    await ok({ asset_id: assetId, op: "update", expected_revision: fresh.revision, edits: [{ op: "set_slot_text", slot: "headline", text: THAI_TITLE }] });
    expect(captured).toEqual([]);

    reply = { options: [ENGLISH_TITLE, "Stuck at a red light and still this cool", "Red light, still cool"] };
    const english = await ok<Suggestions>({ asset_id: assetId, op: "suggest", kind: "translate" });
    expect(english).toEqual({
      asset_id: assetId,
      kind: "translate",
      slot: "secondary",
      language: "en",
      text: THAI_TITLE,
      options: [ENGLISH_TITLE, "Stuck at a red light and still this cool", "Red light, still cool"],
      model: "gpt-6-astra",
      context: null,
    });
    expect(prompt(0)).toContain("Translate the headline of a short vertical video into English.");
    expect(prompt(0)).toContain("Give 3 options");
    expect(prompt(0)).toContain(`HEADLINE: ${THAI_TITLE}`);

    reply = { options: ["ติดไฟแดงยังไงให้เท่", "ไฟแดงก็เท่ได้", "เท่ได้แม้ติดไฟแดง"] };
    const thai = await ok<Suggestions>({ asset_id: assetId, op: "suggest", kind: "translate", text: `  ${ENGLISH_TITLE}\n` });
    expect(thai).toMatchObject({ kind: "translate", slot: "secondary", language: "th", text: ENGLISH_TITLE });
    expect(prompt(1)).toContain("into Thai.");
    expect(prompt(1)).toContain(`HEADLINE: ${ENGLISH_TITLE}`);
    expect(suggestJobs(assetId)).toHaveLength(2);
  });

  it("follows a derived clip back to its download for the title and description", async () => {
    const source = await video(DOWNLOAD);
    const clip = await video({ origin: "graphics" });
    const notebook = await engine.notebooks.create(`Suggest ${randomUUID()}`);
    if (!notebook.ok) throw new Error(notebook.error.message);
    const sourceCell = engine.notebooks.createCell({ type: "video", slot: { row: 0, column: 0 }, outputArtifactId: source, inputs: { sourceOperation: "download_video" } });
    const clipCell = engine.notebooks.createCell({ type: "video", slot: { row: 1, column: 0 }, outputArtifactId: clip, inputs: { sourceOperation: "video_graphics", sourceArtifactId: source } });
    const written = await engine.notebooks.write({ ...notebook.value, cells: [sourceCell, clipCell] });
    if (!written.ok) throw new Error(written.error.message);
    reply = { options: ["ร่มชมพู", "ไฟแดง", "ฝนตก"] };

    const suggested = await ok<Suggestions>({ asset_id: clip, op: "suggest" });

    expect(suggested).toMatchObject({ asset_id: clip, context: { analysis: false, transcript: false, download: true } });
    expect(prompt(0)).toContain("Title: Pink umbrella rider at a red light");
    expect(prompt(0)).toContain("VIDEO ANALYSIS: none");
    expect(prompt(0)).toContain("TRANSCRIPT: none");
  });

  it("answers with a structured error and starts no job or model call when it cannot suggest", async () => {
    const bare = await video();
    expect(await fails({ asset_id: bare, op: "suggest" })).toMatchObject({
      status: "no_context",
      message: expect.stringMatching(/no analysis, transcript or download title.*\/transcribe/u),
    });
    expect(await fails({ asset_id: bare, op: "suggest", kind: "translate" })).toMatchObject({ status: "invalid", message: expect.stringMatching(/needs a headline/u) });
    expect(await fails({ asset_id: bare, op: "suggest", kind: "translate", text: " \n " })).toMatchObject({ status: "invalid" });
    expect(await fails({ op: "suggest" })).toMatchObject({ status: "invalid", message: expect.stringMatching(/suggest needs asset_id/u) });

    const created = await engine.artifacts.create("image", "logo");
    if (!created.ok) throw new Error(created.error.message);
    expect(await fails({ asset_id: created.value.artifactId, op: "suggest" })).toMatchObject({ status: "invalid", message: expect.stringMatching(/go on a video/u) });

    const titled = await video(DOWNLOAD);
    delete process.env.OPENAI_API_KEY;
    expect(await fails({ asset_id: titled, op: "suggest" })).toMatchObject({ status: "not_ready", message: expect.stringMatching(/OPENAI_API_KEY is not set/u) });

    expect(captured).toEqual([]);
    expect([...suggestJobs(bare), ...suggestJobs(titled), ...suggestJobs(created.value.artifactId)]).toEqual([]);
  });

  it("fails a reply with no usable options without marking the video failed", async () => {
    const assetId = await video(DOWNLOAD);
    reply = { options: ["  ", "x".repeat(300), "“”"] };

    const failure = await fails({ asset_id: assetId, op: "suggest" });

    expect(failure.message).toMatch(/Astra returned no usable suggestions/u);
    expect(captured).toHaveLength(1);
    expect(suggestJobs(assetId)).toEqual([expect.objectContaining({ state: "failed", artifactId: null })]);
    const artifact = engine.artifacts.get(assetId);
    expect(artifact.ok && artifact.value.kind).toBe("video");
    expect((await ok<Read>({ asset_id: assetId })).document.layers.length).toBeGreaterThan(0);
  });

  it("is billable only for suggest", () => {
    expect(toolSpendsMoney("video_graphics", { op: "suggest" })).toBe(true);
    expect(toolSpendsMoney("video_graphics", { op: "suggest", kind: "translate" })).toBe(true);
    expect(toolSpendsMoney("video_graphics", { op: "get" })).toBe(false);
    expect(toolSpendsMoney("video_graphics", {})).toBe(false);
    expect(toolSpendsMoney("video_graphics", { op: "update" })).toBe(false);
    expect(toolSpendsMoney("video_graphics", { op: "render" })).toBe(false);
    expect(toolSpendsMoney("video_graphics", { op: "save_template" })).toBe(false);
  });
});

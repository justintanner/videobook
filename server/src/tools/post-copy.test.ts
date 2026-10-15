import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine } from "videobook-engine";
import type { Engine, NotebookCell, NotebookDocument } from "videobook-engine";
import { createPost } from "../posts/post-store.js";
import { buildPostCopyPrompt, draftPostCopy, postAnalysisTarget, postCopyResponses, readPostCopyContext } from "../posts/post-copy.js";
import { joinCaptionTags, normalizePostTags, splitCaptionTags } from "../posts/post-copy-format.js";
import { VIDEO_ANALYSIS_FILE } from "../video-analysis-projection.js";

function value<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

type CapturedRequest = { model: string; input: Array<{ content: string }>; text: { format: { type: string; name: string } } };

function responsesBody(text: string): string {
  return JSON.stringify({
    id: "resp_post_copy", object: "response", created_at: 0, status: "completed", model: "gpt-6-astra",
    output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
    instructions: null, previous_response_id: null, temperature: null, top_p: null, max_output_tokens: null,
    store: false, tools: [], reasoning: null, text: { format: { type: "text" } },
    usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 }, error: null, incomplete_details: null, metadata: {},
  });
}

describe("caption and tag format", () => {
  it("splits a trailing hashtag line into tags and joins it back", () => {
    const parts = splitCaptionTags("Riding out the storm.\n\n#lightning #ฝนตก #rain_day");
    expect(parts).toEqual({ body: "Riding out the storm.", tags: ["lightning", "ฝนตก", "rain_day"] });
    expect(joinCaptionTags(parts.body, parts.tags)).toBe("Riding out the storm.\n\n#lightning #ฝนตก #rain_day");
  });

  it("leaves inline hashtags in the caption body", () => {
    expect(splitCaptionTags("Storm day #1 was wild")).toEqual({ body: "Storm day #1 was wild", tags: [] });
    expect(joinCaptionTags("Just text", [])).toBe("Just text");
    expect(joinCaptionTags("", ["only"])).toBe("#only");
  });

  it("normalizes, dedupes and caps tags", () => {
    expect(normalizePostTags(["#Rain day", "rain", "rainday", "#", "พายุ!"], 3)).toEqual(["Rainday", "rain", "พายุ"]);
  });
});

describe("draft_post_copy with Astra", () => {
  let root: string;
  let engine: Engine;
  let notebook: NotebookDocument;
  let source: NotebookCell;
  let artifactId: string;
  const servers: Server[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "post-copy-"));
    engine = createEngine({ rootDir: root, initialBookName: "post-copy", durableWrites: false });
    await engine.ready;
    notebook = value(await engine.notebooks.create("Clips"));
    const artifact = value(await engine.artifacts.create("video", "Umbrella ride"));
    artifactId = artifact.artifactId;
    value(await engine.files.write(artifactId, "original.mp4", Buffer.from("clip bytes")));
    const idea = engine.notebooks.createCell({ type: "prompt", prompt: "A man rides a scooter in heavy rain holding a pink umbrella", slot: { row: 0, column: 0 } });
    source = engine.notebooks.createCell({ type: "video", slot: { row: 0, column: 1 }, outputArtifactId: artifactId, label: "Umbrella ride" });
    notebook = { ...notebook, cells: [idea, source], edges: [engine.notebooks.createEdge({ source: idea.id, target: source.id, targetInput: "media" })] };
    value(await engine.notebooks.write(notebook));
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
    engine.close();
    await rm(root, { recursive: true, force: true });
  });

  async function astraServer(reply: string, captured: CapturedRequest[]): Promise<string> {
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      request.on("end", () => {
        captured.push(JSON.parse(body) as CapturedRequest);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(responsesBody(reply));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server has no port");
    return `http://127.0.0.1:${address.port}`;
  }

  it("reports a clip that still needs analysis", async () => {
    const post = await createPost(engine, { notebookId: notebook.id, sourceCellId: source.id, platform: "tiktok" });
    expect(post.definition).toMatchObject({ platform: "tiktok", delivery: "icloud" });
    expect(await postAnalysisTarget(engine, post)).toEqual({ assetId: artifactId, analyzable: true, analyzed: false });
  });

  it("drafts Thai copy for the Post's platform from the clip analysis", async () => {
    value(await engine.files.write(artifactId, VIDEO_ANALYSIS_FILE, Buffer.from(JSON.stringify({
      summary: "A man rides a scooter through heavy rain under a pink umbrella.",
      mood: "defiant", setting: "city street", subjects: ["rider", "pink umbrella"], actions: ["riding"],
      tags: ["rain", "umbrella"], scenes: [{ timestamp: 0, description: "Rider enters frame", tags: [] }], textOnScreen: [],
    }))));
    const post = await createPost(engine, { notebookId: notebook.id, sourceCellId: source.id, platform: "tiktok" });
    expect(await postAnalysisTarget(engine, post)).toEqual({ assetId: artifactId, analyzable: true, analyzed: true });

    const captured: CapturedRequest[] = [];
    const baseURL = await astraServer(JSON.stringify({ caption: "ฝ่าพายุไปกับร่มสีชมพู", tags: ["#ฝนตก", "lightning", "ฝนตก", "rain", "storm", "city", "extra"] }), captured);
    const context = await readPostCopyContext(engine, post);
    const draft = await draftPostCopy(postCopyResponses("local-test-key", { baseURL, retries: 0 }), context, { platform: "tiktok", language: "th", instruction: "mention the storm" });

    expect(draft).toEqual({ caption: "ฝ่าพายุไปกับร่มสีชมพู", tags: ["fyp", "bkk", "ฝนตก", "lightning", "rain"], platform: "tiktok", language: "th", model: "gpt-6-astra", analyzed: true });
    expect(captured).toHaveLength(1);
    expect(captured[0].model).toBe("gpt-6-astra");
    expect(captured[0].text.format).toMatchObject({ type: "json_schema", name: "post_copy" });
    const prompt = captured[0].input[0].content;
    expect(prompt).toContain("posted on TikTok");
    expect(prompt).toContain("in Thai");
    expect(prompt).toContain("heavy rain under a pink umbrella");
    expect(prompt).toContain("INSTRUCTION FROM THE CREATOR: mention the storm");
    expect(prompt).toContain("A man rides a scooter in heavy rain holding a pink umbrella");
    expect(prompt).toContain("under 2200 characters");
    expect(prompt).toContain("one or two words plus one or two emoji");
    expect(prompt).toContain("describes this clip");
    expect(prompt).not.toContain("Mr Bean");
  });

  it("asks for a title of this clip and does not copy another video's caption", () => {
    const prompt = buildPostCopyPrompt({
      label: "Rain clip",
      analysis: {
        summary: "A rider under a pink umbrella.",
        mood: "defiant",
        setting: "city street",
        subjects: ["rider"],
        actions: ["riding"],
        tags: ["rain"],
        scenes: ["Rider enters"],
        textOnScreen: [],
      },
      transcript: null,
      prompts: ["scooter in rain"],
    }, { platform: "tiktok", language: "th" });
    expect(prompt).toContain("pink umbrella");
    expect(prompt).toContain("one or two words plus one or two emoji");
    expect(prompt).toContain("The title describes this clip");
    expect(prompt).not.toContain("Mr Bean");
  });

  it("rewrites the current draft and rejects an empty caption", async () => {
    const post = await createPost(engine, { notebookId: notebook.id, sourceCellId: source.id, platform: "x" });
    expect(post.definition.delivery).toBeUndefined();
    const captured: CapturedRequest[] = [];
    const baseURL = await astraServer(JSON.stringify({ caption: "  ", tags: [] }), captured);
    const context = await readPostCopyContext(engine, post);
    expect(context.analysis).toBeNull();

    await expect(draftPostCopy(postCopyResponses("local-test-key", { baseURL, retries: 0 }), context, { platform: "x", language: "en", caption: "Old caption", tags: ["old"] }))
      .rejects.toThrow("Astra returned an empty caption.");
    const prompt = captured[0].input[0].content;
    expect(prompt).toContain("CURRENT DRAFT");
    expect(prompt).toContain("Caption: Old caption");
    expect(prompt).toContain("Tags: #old");
    expect(prompt).toContain("VIDEO ANALYSIS: none available");
    expect(prompt).toContain("under 280 characters");
  });
});

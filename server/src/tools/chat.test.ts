import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { createEngineForTest } from "../engine.js";
import { v7 as uuidv7 } from "uuid";
import {
  applySpeechRoutingDefaults,
  chatActionPlanSchema,
  duplicateDestinationReference,
  loadScriptContentsForChat,
  normalizeChatRoutedParams,
  normalizeChatTimestampParams,
  parseChatDecision,
  repairChatRoutingJson,
  sanitizeGenerateImageParams,
  enrichAssetContext,
} from "./chat.js";
import { SCRIPT_FILENAME } from "../jobs/describe-image.js";
import { queue, waitForJob } from "../queue.js";
import type { Client } from "@modelcontextprotocol/client";

type TextContent = Array<{ type: string; text: string }>;

describe("duplicateDestinationReference", () => {
  it("preserves explicit and positional duplicate destinations", () => {
    expect(duplicateDestinationReference("duplicate @a1 to @Z13"))
      .toBe("z13");
    expect(duplicateDestinationReference("copy @a1 @b2"))
      .toBe("b2");
  });

  it("does not treat a lone source as a destination", () => {
    expect(duplicateDestinationReference("duplicate @a1")).toBeNull();
    expect(duplicateDestinationReference("inspect @a1 and @b2")).toBeNull();
  });
});

describe("normalizeChatRoutedParams", () => {
  it("unwraps a single media_context object from an array", () => {
    const context = {
      notebook_id: "019fcc00-0000-7000-8000-000000000011",
      cell_id: "019fcc00-0000-7000-8000-000000000012",
      artifact_id: "019fcc00-0000-7000-8000-000000000013",
    };
    expect(normalizeChatRoutedParams("plan_chat_command", {
      prompt: "insert this at frame 120",
      media_context: [context],
    })).toEqual({
      prompt: "insert this at frame 120",
      media_context: context,
    });
  });

  it("drops a multi-clip media_context array on plan_chat_command", () => {
    expect(normalizeChatRoutedParams("plan_chat_command", {
      prompt: "splice together these clips",
      media_context: [
        { artifact_id: "019fcc00-0000-7000-8000-000000000001" },
        { artifact_id: "019fcc00-0000-7000-8000-000000000002" },
      ],
    })).toEqual({
      prompt: "splice together these clips",
    });
  });

  it("expands splice asset_ids and defaults overlap to 0", () => {
    expect(normalizeChatRoutedParams("splice_video", {
      asset_ids: [
        "@019fcc00-0000-7000-8000-000000000001",
        "019fcc00-0000-7000-8000-000000000002",
        "019fcc00-0000-7000-8000-000000000003",
      ],
      media_context: [{ artifact_id: "ignored" }],
    })).toEqual({
      first_asset_id: "019fcc00-0000-7000-8000-000000000001",
      second_asset_id: "019fcc00-0000-7000-8000-000000000002",
      additional_asset_ids: ["019fcc00-0000-7000-8000-000000000003"],
      overlap: 0,
    });
  });
});

describe("normalizeChatTimestampParams", () => {
  it("normalizes nested sync anchors without changing cue strings", () => {
    const source = {
      asset_id: "vid-frankenstein",
      anchors: [
        { video_seconds: "0:03", audio_cue: "England" },
        { video_seconds: "6s", audio_seconds: "0:05.96" },
        { video_seconds: "bad", audio_cue: "America" },
      ],
    };
    expect(normalizeChatTimestampParams("sync_video_to_audio", source)).toEqual({
      asset_id: "vid-frankenstein",
      anchors: [
        { video_seconds: 3, audio_cue: "England" },
        { video_seconds: 6, audio_seconds: 5.96 },
        { video_seconds: "bad", audio_cue: "America" },
      ],
    });
    expect(source.anchors[0].video_seconds).toBe("0:03");
  });

  it("retains top-level timestamp normalization", () => {
    expect(normalizeChatTimestampParams("timewarp_video", {
      start_seconds: "0:03",
      end_seconds: "6.5s",
      stretch_factor: 1.5,
    })).toEqual({
      start_seconds: 3,
      end_seconds: 6.5,
      stretch_factor: 1.5,
    });
  });

  it("normalizes extract_frame timestamp strings to seconds", () => {
    expect(normalizeChatTimestampParams("extract_frame", {
      asset_id: "vid-frankenstein",
      timestamp: "1:30",
    })).toEqual({
      asset_id: "vid-frankenstein",
      timestamp: 90,
    });
    expect(normalizeChatTimestampParams("extract_frame", {
      asset_id: "vid-frankenstein",
      timestamp: 12,
    })).toEqual({
      asset_id: "vid-frankenstein",
      timestamp: 12,
    });
  });
});

// Per-test createTestClient + create_project under parallel test load was
// blowing past the 60s hook budget — every per-test call stomps the queue's
// global projectsDir, racing concurrent suites into ENOENT. Tests don't
// share persistent state in conflicting ways; only the OPENAI_API_KEY env
// mutation needs per-test cleanup.
describe("chat tool", () => {
  let client: Client;
  let tempDir: string;
  const origKey = process.env.OPENAI_API_KEY;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
    });
  });

  afterAll(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  afterEach(() => {
    if (origKey) process.env.OPENAI_API_KEY = origKey;
    else delete process.env.OPENAI_API_KEY;
  });

  it("returns error for unresolved @tag", async () => {
    const result = await client.callTool({
      name: "chat",
      arguments: {
        prompt: "do something with @019fcc00-0000-7000-8000-00000000dead",
        book_id: "test-proj",
      },
    });
    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("Asset not found");
  });

  it("returns error when OPENAI_API_KEY is not set", async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await client.callTool({
      name: "chat",
      arguments: {
        prompt: "generate something cool",
        book_id: "test-proj",
      },
    });
    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("not set");
  });

  it("resolves real @tags then returns API key error", async () => {
    // Upload an image to create a real asset
    const data = Buffer.from("fake-png-data").toString("base64");
    await client.callTool({
      name: "upload_file",
      arguments: { book_id: "test-proj", filename: "sunset.png", data },
    });

    delete process.env.OPENAI_API_KEY;
    const result = await client.callTool({
      name: "chat",
      arguments: {
        prompt: "do something with @img-sunset",
        book_id: "test-proj",
      },
    });

    // Asset resolution succeeds (no "Asset not found" error) but API key check fails
    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("OPENAI_API_KEY");
    expect(content[0].text).not.toContain("Asset not found");
  });

  it("preserves an empty duplicate destination for routing", async () => {
    const data = Buffer.from("duplicate-source").toString("base64");
    const uploaded = await client.callTool({
      name: "upload_file",
      arguments: { book_id: "test-proj", filename: "duplicate.png", data },
    });
    const assetId = (JSON.parse(
      (uploaded.content as TextContent)[0].text,
    ) as { assetId: string }).assetId;
    const createdNotebook = await client.callTool({
      name: "create_notebook",
      arguments: { book_id: "test-proj", name: "Duplicate routing" },
    });
    const notebookId = (JSON.parse(
      (createdNotebook.content as TextContent)[0].text,
    ) as { id: string }).id;
    await client.callTool({
      name: "create_notebook_cell",
      arguments: {
        book_id: "test-proj",
        notebook_id: notebookId,
        cell: {
          type: "image",
          slot: { row: 0, column: 0 },
          output_artifact_id: assetId,
        },
      },
    });

    delete process.env.OPENAI_API_KEY;
    const result = await client.callTool({
      name: "chat",
      arguments: {
        prompt: "duplicate @a1 to @b1",
        book_id: "test-proj",
        notebook_id: notebookId,
      },
    });
    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("OPENAI_API_KEY");
    expect(content[0].text).not.toContain("Asset not found");
  });

  it("returns error for multiple unresolved @tags", async () => {
    const result = await client.callTool({
      name: "chat",
      arguments: {
        prompt: "combine @019fcc00-0000-7000-8000-0000000000f0 and @019fcc00-0000-7000-8000-0000000000f1",
        book_id: "test-proj",
      },
    });
    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("Asset not found");
    expect(content[0].text).toContain("@019fcc00-0000-7000-8000-0000000000f0");
    expect(content[0].text).toContain("@019fcc00-0000-7000-8000-0000000000f1");
  });

  it("prompt without @tags and no API key returns API key error", async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await client.callTool({
      name: "chat",
      arguments: {
        prompt: "make me a cool video",
        book_id: "test-proj",
      },
    });
    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("OPENAI_API_KEY");
  });
});

describe("chatActionPlanSchema and applyChatActionPlan", () => {
  let client: Client;
  let tempDir: string;
  let bookId: string;

  beforeAll(async () => {
    await queue.start();
    tempDir = await mkdtemp(join(tmpdir(), "videocity-chat-plan-"));
    client = await createTestClient(tempDir);
    const created = await client.callTool({
      name: "create_project",
      arguments: { book_id: "chat-plan-proj" },
    });
    bookId = (JSON.parse(
      (created.content as TextContent)[0].text,
    ) as { bookId: string }).bookId;
  });

  afterAll(async () => {
    await client?.close();
    await queue.stop();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("accepts confirmation.required true and false", () => {
    const base = {
      kind: "chat-action-plan" as const,
      planId: uuidv7(),
      bookId: uuidv7(),
      prompt: "extract the first frame of @a1",
      routedTool: "extract_first_frame",
      tool: "extract_first_frame",
      params: { asset_id: uuidv7() },
      message: "Extracting frame.",
      summary: "Extract first frame",
      effect: "mutation" as const,
    };
    expect(chatActionPlanSchema.safeParse({
      ...base,
      confirmation: {
        required: false,
        reason: "Frame extraction is free and only adds a new image cell",
      },
    }).success).toBe(true);
    expect(chatActionPlanSchema.safeParse({
      ...base,
      confirmation: {
        required: true,
        reason: "This request changes the current book",
      },
    }).success).toBe(true);
    expect(chatActionPlanSchema.safeParse({
      ...base,
      confirmation: { required: "yes", reason: "bad" },
    }).success).toBe(false);
  });

  it("applies extract_first_frame action plans against a real engine", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { createRequire } = await import("node:module");
    const { readFile } = await import("node:fs/promises");
    const execFileAsync = promisify(execFile);
    const require = createRequire(import.meta.url);
    const FFMPEG: string = require("ffmpeg-static");
    const videoPath = join(tempDir, "plan-source.mp4");
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi",
      "-i", "color=c=red:s=64x64:r=10:d=1",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      videoPath,
    ]);
    const data = (await readFile(videoPath)).toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: {
        book_id: "chat-plan-proj",
        filename: "plan-source.mp4",
        data,
      },
    });
    const upload = JSON.parse(
      (uploadResult.content as TextContent)[0].text,
    ) as { assetId: string };
    const plan = {
      kind: "chat-action-plan",
      planId: uuidv7(),
      bookId,
      prompt: "extract the first frame",
      routedTool: "extract_first_frame",
      tool: "extract_first_frame",
      params: { asset_id: upload.assetId, book_id: bookId },
      message: "Extracting frame.",
      summary: "Extract first frame",
      effect: "mutation",
      confirmation: {
        required: false,
        reason: "Frame extraction is free and only adds a new image cell",
      },
    };
    expect(chatActionPlanSchema.safeParse(plan).success).toBe(true);
    const result = await client.callTool({
      name: "chat",
      arguments: {
        book_id: "chat-plan-proj",
        action_plan: plan,
      },
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(
      (result.content as TextContent)[0].text,
    ) as { job_id?: string; image_asset_id?: string };
    expect(payload.job_id).toBeTruthy();
    if (payload.job_id) await waitForJob(payload.job_id);
    expect(payload.image_asset_id).toBeTruthy();
  }, 30_000);
});

describe("sanitizeGenerateImageParams", () => {
  it("folds @vid-* image_refs into prompt and keeps only @img-*", () => {
    const out = sanitizeGenerateImageParams({
      prompt: "qr code",
      image_refs: ["@vid-og", "@img-style"],
    });
    expect(out.image_refs).toEqual(["@img-style"]);
    expect(out.prompt).toBe("qr code (from source @vid-og)");
  });

  it("builds a prompt when only non-image slugs are present", () => {
    const out = sanitizeGenerateImageParams({
      image_refs: ["@vid-og"],
    });
    expect(out.image_refs).toEqual([]);
    expect(out.prompt).toBe("from source @vid-og");
  });

  it("leaves params unchanged when image_refs is absent", () => {
    const input = { prompt: "qr code image" };
    expect(sanitizeGenerateImageParams(input)).toEqual(input);
  });
});

describe("applySpeechRoutingDefaults", () => {
  const origCustomVoices = process.env.ELEVENLABS_CUSTOM_VOICE_IDS;

  afterEach(() => {
    if (origCustomVoices !== undefined) {
      process.env.ELEVENLABS_CUSTOM_VOICE_IDS = origCustomVoices;
    } else {
      delete process.env.ELEVENLABS_CUSTOM_VOICE_IDS;
    }
  });

  it("leaves non-speech tools untouched", async () => {
    const params = { prompt: "a red fox" };
    expect(await applySpeechRoutingDefaults("generate_video", params))
      .toBe(params);
  });

  it("keeps explicit text and voice as provided", async () => {
    const result = await applySpeechRoutingDefaults(
      "generate_elevenlabs_text_to_audio",
      { text: "welcome back", voice_id: "voice-explicit" },
    );
    expect(result.text).toBe("welcome back");
    expect(result.voice_id).toBe("voice-explicit");
  });

  it("folds prompt into text when the router omitted text", async () => {
    process.env.ELEVENLABS_CUSTOM_VOICE_IDS = "Narrator=custom-voice-1";
    const result = await applySpeechRoutingDefaults(
      "generate_elevenlabs_text_to_audio",
      { prompt: "welcome back everyone" },
    );
    expect(result.text).toBe("welcome back everyone");
  });

  it("defaults an omitted voice_id from the catalog, custom voices first", async () => {
    process.env.ELEVENLABS_CUSTOM_VOICE_IDS = "Narrator=custom-voice-1";
    const result = await applySpeechRoutingDefaults(
      "generate_elevenlabs_text_to_audio",
      { text: "welcome back" },
    );
    expect(result.voice_id).toBe("custom-voice-1");
  });
});

describe("parseChatDecision / repairChatRoutingJson", () => {
  it("parses clean routing JSON", () => {
    const decision = parseChatDecision(
      '{"tool":"create_watermark_card","params":{"url":"https://www.youtube.com/watch?v=b-3853ow72Q"},"message":"Creating QR."}',
    );
    expect(decision.tool).toBe("create_watermark_card");
    expect(decision.params.url).toBe("https://www.youtube.com/watch?v=b-3853ow72Q");
    expect(decision.message).toBe("Creating QR.");
  });

  it("repairs unquoted URLs and trailing commas", () => {
    const raw =
      '{"tool":"create_watermark_card","params":{"url":https://www.youtube.com/watch?v=b-3853ow72Q,},"message":"Creating QR.",}';
    expect(() => JSON.parse(raw)).toThrow();
    const repaired = repairChatRoutingJson(raw);
    const decision = parseChatDecision(raw);
    expect(repaired).toContain('"https://www.youtube.com/watch?v=b-3853ow72Q"');
    expect(decision.tool).toBe("create_watermark_card");
    expect(decision.params.url).toBe("https://www.youtube.com/watch?v=b-3853ow72Q");
  });

  it("closes truncated routing JSON missing outer brace and message (live Kie failure)", () => {
    // Exact shape from live multiculty/@vid-og failure (position 106).
    const raw = `{
  "tool": "create_watermark_card",
  "params": {
    "url": "https://www.youtube.com/watch?v=b-3853ow72Q"
  }`;
    expect(() => JSON.parse(raw)).toThrow();
    const decision = parseChatDecision(raw);
    expect(decision.tool).toBe("create_watermark_card");
    expect(decision.params.url).toBe("https://www.youtube.com/watch?v=b-3853ow72Q");
    expect(decision.message).toBe("");
  });

  it("closes truncated string values mid-message", () => {
    const raw =
      '{"tool":"create_watermark_card","params":{"url":"https://x.com/a"},"message":"Creat';
    const decision = parseChatDecision(raw);
    expect(decision.tool).toBe("create_watermark_card");
    expect(decision.params.url).toBe("https://x.com/a");
    expect(decision.message).toBe("Creat");
  });

  it("includes a raw snippet when JSON is unrecoverable", () => {
    expect(() => parseChatDecision("not json at all")).toThrow(/raw:/);
  });
});

describe("enrichAssetContext", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("attaches source_url from native original metadata", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-chat-enrich-"));
    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("vid", "og");
    expect(asset.ok).toBe(true);
    if (!asset.ok) return;

    await fs.metadata.artifacts.write(asset.value.artifactId, "original", {
        origin: "download",
        source_url: "https://www.youtube.com/watch?v=b-3853ow72Q",
      }
    );

    const rows = await enrichAssetContext(
      fs,
      [{
        tag: asset.value.artifactId,
        artifactType: "video",
        artifactId: asset.value.artifactId,
        filePath: join(asset.value.path, "original.mp4"),
        workspacePath: asset.value.path,
      }],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.source_url).toBe("https://www.youtube.com/watch?v=b-3853ow72Q");
    fs.close();
  });
});

describe("loadScriptContentsForChat", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("reads script body from original.md (not index.md)", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-chat-script-"));
    const fs = createEngineForTest(tempDir);

    const script = await fs.artifacts.create("script", "chapter-one");
    if (!script.ok) throw new Error(script.error.message);

    const body = "A pig sits upright on a red stool.";
    const wrote = await fs.files.write(script.value.artifactId, SCRIPT_FILENAME, body);
    expect(wrote.ok).toBe(true);

    const decoy = await fs.files.write(script.value.artifactId, "index.md", "WRONG PLAN FILE");
    expect(decoy.ok).toBe(true);

    const contents = await loadScriptContentsForChat(
      fs,
      [{
        tag: script.value.artifactId,
        artifactType: "script",
        artifactId: script.value.artifactId,
        filePath: join(script.value.path, SCRIPT_FILENAME),
        workspacePath: script.value.path,
      }],
    );

    expect(contents).toEqual([{ tag: script.value.artifactId, content: body }]);
    expect(contents[0]?.content).not.toContain("WRONG PLAN FILE");
    fs.close();
  });

  it("returns empty when only index.md exists (legacy wrong path)", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-chat-script-bad-"));
    const fs = createEngineForTest(tempDir);
    const script = await fs.artifacts.create("script", "orphan");
    if (!script.ok) throw new Error(script.error.message);
    await fs.files.write(script.value.artifactId, "index.md", "should not be loaded");

    const contents = await loadScriptContentsForChat(
      fs,
      [{
        tag: script.value.artifactId,
        artifactType: "script",
        artifactId: script.value.artifactId,
        filePath: join(script.value.path, "index.md"),
        workspacePath: script.value.path,
      }],
    );

    expect(contents).toEqual([]);
    fs.close();
  });
});

import { createEngineForTest } from "../engine.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { findVideoFile, type Engine } from "videobook-engine";
import { createTestClient } from "../test-client.js";
import {
  keywordPlacementFingerprint,
  writeKeywordPlacementAnalysis,
} from "../keyword-placement-cache.js";
import {
  parseKeywordTranscript,
  selectKeywordGraphics,
  selectRequestedKeywordGraphics,
} from "../remotion/keyword-graphics.js";
import {
  KEYWORD_FRAME_CACHE_FILENAME,
  KEYWORD_PLACEMENT_VERSION,
  keywordCueId,
} from "../remotion/keyword-placement.js";

type TextContent = Array<{ type: string; text: string }>;

const ORIENTATIONS = ["landscape", "portrait", "square"] as const;

describe("animate_keywords tool", () => {
  let client: Client;
  let fs: Engine;
  let tempDir: string;
  const bookId = "test-proj";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-animate-keywords-test-"));
    client = await createTestClient(tempDir);
    fs = createEngineForTest(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: bookId },
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function createVideo(withTranscript: boolean): Promise<string> {
    const created = await fs.artifacts.create("vid", "interview");
    if (!created.ok) throw new Error(created.error.message);
    const video = await fs.files.write(created.value.artifactId, "original.mp4", Buffer.from("video"));
    if (!video.ok) throw new Error(video.error.message);
    if (withTranscript) {
      const transcript = {
        language_code: "eng",
        words: [
          { text: "cinema", start: 0.5, end: 0.9, type: "word" },
          { text: "changes", start: 4, end: 4.4, type: "word" },
          { text: "everything", start: 7.5, end: 8, type: "word" },
          { text: "forever", start: 11, end: 11.4, type: "word" },
        ],
      };
      const written = await fs.files.write(created.value.artifactId, "elevenlabs.json", JSON.stringify(transcript)
      );
      if (!written.ok) throw new Error(written.error.message);
    }
    return created.value.artifactId;
  }

  async function seedPlacementCache(assetId: string, keywords?: string[]): Promise<void> {
    const transcript = await fs.files.read(assetId, "elevenlabs.json");
    if (!transcript.ok) throw new Error(transcript.error.message);
    const segments = parseKeywordTranscript(JSON.parse(transcript.value.toString()) as unknown);
    const graphics = keywords
      ? selectRequestedKeywordGraphics(segments, keywords).graphics
      : selectKeywordGraphics(segments);
    const manifest = await fs.files.manifest(assetId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    const videoFile = findVideoFile(manifest.value.files);
    if (!videoFile) throw new Error("test video missing");
    const fingerprint = keywordPlacementFingerprint(videoFile, transcript.value, graphics);
    const frameCache = await fs.files.write(assetId, KEYWORD_FRAME_CACHE_FILENAME, Buffer.from("cached-frame-sheet")
    );
    if (!frameCache.ok) throw new Error(frameCache.error.message);
    await writeKeywordPlacementAnalysis(fs, assetId, {
      version: KEYWORD_PLACEMENT_VERSION,
      fingerprint,
      sourceWidth: 1920,
      sourceHeight: 1080,
      frameCacheFilename: KEYWORD_FRAME_CACHE_FILENAME,
      analyzedAt: "2026-07-18T00:00:00.000Z",
      cues: graphics.map((graphic) => ({
        cueId: keywordCueId(graphic),
        text: graphic.text,
        frameTime: graphic.frameTime ?? graphic.start,
        regions: [],
      })),
    });
  }

  it("selects transcript cues and persists defaults for every orientation", async () => {
    const assetId = await createVideo(true);
    await seedPlacementCache(assetId);

    const result = await client.callTool({
      name: "animate_keywords",
      arguments: { asset_id: assetId, book_id: bookId },
    });

    expect(result.isError).toBeFalsy();
    const response = JSON.parse((result.content as TextContent)[0].text) as Record<string, unknown>;
    expect(response.status).toBe("configured");
    expect(response.enabled).toBe(true);
    expect(response.style).toBe("cinematic-serif");
    expect(response.placement_status).toBe("completed");
    expect(response.cached).toBe(true);
    expect(response.keywords).toHaveLength(4);

    for (const orientation of ORIENTATIONS) {
      const metadata = await fs.metadata.artifacts.read<Record<string, unknown>>(assetId, `${orientation}.render`
      );
      if (!metadata.ok) throw new Error(metadata.error.message);
      expect(metadata.value.keywordGraphicsEnabled).toBe(true);
      expect(metadata.value.keywordGraphicsMaxCount).toBe(8);
      expect(metadata.value.keywordGraphicsLingerSeconds).toBe(2.4);
    }
  });

  it("turns keyword graphics off without requiring a transcript", async () => {
    const assetId = await createVideo(false);

    const result = await client.callTool({
      name: "animate_keywords",
      arguments: { asset_id: assetId, book_id: bookId, enabled: false },
    });

    expect(result.isError).toBeFalsy();
    for (const orientation of ORIENTATIONS) {
      const metadata = await fs.metadata.artifacts.read<Record<string, unknown>>(assetId, `${orientation}.render`
      );
      if (!metadata.ok) throw new Error(metadata.error.message);
      expect(metadata.value.keywordGraphicsEnabled).toBe(false);
    }
  });

  it("persists explicit transcript words for every orientation", async () => {
    const assetId = await createVideo(true);
    await seedPlacementCache(assetId, ["Everything", "Cinema"]);

    const result = await client.callTool({
      name: "animate_keywords",
      arguments: {
        asset_id: assetId,
        book_id: bookId,
        keywords: ["Everything", "Cinema"],
      },
    });

    expect(result.isError).toBeFalsy();
    const response = JSON.parse((result.content as TextContent)[0].text) as Record<string, unknown>;
    expect(response.mode).toBe("explicit");
    expect(response.requested_keywords).toEqual(["Cinema", "Everything"]);
    for (const orientation of ORIENTATIONS) {
      const metadata = await fs.metadata.artifacts.read<Record<string, unknown>>(assetId, `${orientation}.render`
      );
      if (!metadata.ok) throw new Error(metadata.error.message);
      expect(metadata.value.keywordGraphicsKeywords).toEqual(["Cinema", "Everything"]);
    }
  });

  it("returns a structured error for explicit words absent from the transcript", async () => {
    const assetId = await createVideo(true);

    const result = await client.callTool({
      name: "animate_keywords",
      arguments: {
        asset_id: assetId,
        book_id: bookId,
        keywords: ["Cinema", "Vengeance"],
      },
    });

    expect(result.isError).toBe(true);
    const response = JSON.parse((result.content as TextContent)[0].text) as Record<string, unknown>;
    expect(response.status).toBe("keywords_not_found");
    expect(response.missing_keywords).toEqual(["Vengeance"]);
  });

  it("fails safely without changing settings when vision is unavailable", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const assetId = await createVideo(true);

    const result = await client.callTool({
      name: "animate_keywords",
      arguments: { asset_id: assetId, book_id: bookId },
    });

    expect(result.isError).toBe(true);
    const response = JSON.parse((result.content as TextContent)[0].text) as Record<string, unknown>;
    expect(response.status).toBe("missing_vision_provider");
    for (const orientation of ORIENTATIONS) {
      const metadata = await fs.metadata.artifacts.read<Record<string, unknown>>(assetId, `${orientation}.render`
      );
      expect(metadata.ok).toBe(false);
    }
  });

  it("returns an actionable structured error when the transcript is missing", async () => {
    const assetId = await createVideo(false);

    const result = await client.callTool({
      name: "animate_keywords",
      arguments: { asset_id: assetId, book_id: bookId },
    });

    expect(result.isError).toBe(true);
    const response = JSON.parse((result.content as TextContent)[0].text) as Record<string, unknown>;
    expect(response.status).toBe("missing_transcript");
    expect(response.message).toContain(`/transcribe @${assetId}`);
  });

  it("exposes the /keywords slash command through the MCP registry", async () => {
    const result = await client.callTool({ name: "slash_commands", arguments: { detail: "full" } });
    const commands = JSON.parse((result.content as TextContent)[0].text) as Array<{
      command: string;
      mcpTool?: { tool: string; autoInject?: string[] };
    }>;
    const command = commands.find((entry) => entry.command === "/keywords");

    expect(command?.mcpTool).toEqual({
      tool: "animate_keywords",
      adapter: "keywords",
      autoInject: ["book_id"],
    });
  });
});

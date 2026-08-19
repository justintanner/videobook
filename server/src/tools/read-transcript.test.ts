import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { createEngineForTest } from "../engine.js";
import { queue } from "../queue.js";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";

type TextContent = Array<{ type: string; text: string }>;

interface TimedTranscriptResponse {
  kind: "timed";
  language_code: string | null;
  text: string;
  words: Array<{ text: string; start: number; end: number; speaker_id?: string }>;
}

interface PlainTranscriptResponse {
  kind: "plain";
  text: string;
}

interface SilenceTranscriptResponse {
  kind: "silence";
}

interface MissingTranscriptResponse {
  kind: "missing";
}

type TranscriptResponse =
  | TimedTranscriptResponse
  | PlainTranscriptResponse
  | SilenceTranscriptResponse
  | MissingTranscriptResponse;

describe("read_transcript tool (integration)", () => {
  let client: Client;
  let fs: Engine;
  let tempDir: string;

  beforeAll(async () => {
    await queue.start();
  }, 30_000);

  afterAll(async () => {
    await queue.stop();
  }, 30_000);

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-read-transcript-"));
    fs = createEngineForTest(tempDir);
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "transcript-proj" },
    });
  }, 120_000);

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  }, 120_000);

  async function uploadAndWriteTranscript(
    filename: string,
    content: object | string,
  ): Promise<string> {
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: {
        book_id: "transcript-proj",
        filename: "original.mp4",
        data: Buffer.from("fake-video-data").toString("base64"),
      },
    });
    const asset = JSON.parse((uploadResult.content as TextContent)[0].text);
    const assetId = asset.assetId as string;

    const text = typeof content === "string"
      ? content
      : JSON.stringify(content, null, 2);
    const written = await fs.files.write(assetId, filename, text
    );
    if (!written.ok) throw new Error(written.error.message);

    return assetId;
  }

  async function callReadTranscript(assetId: string): Promise<TranscriptResponse> {
    const result = await client.callTool({
      name: "read_transcript",
      arguments: { asset_id: assetId, book_id: "transcript-proj" },
    });
    expect(result.isError).toBeFalsy();
    return JSON.parse((result.content as TextContent)[0].text) as TranscriptResponse;
  }

  it("returns timed transcript when elevenlabs.json exists with speech words", async () => {
    const elevenLabsJson = {
      language_code: "eng",
      language_probability: 0.99,
      text: "Hello world this is a test",
      words: [
        { text: "Hello", start: 0.0, end: 0.5, type: "word", speaker_id: "spk_0" },
        { text: " ", start: 0.5, end: 0.6, type: "spacing", speaker_id: null },
        { text: "world", start: 0.6, end: 1.0, type: "word", speaker_id: "spk_0" },
        { text: "[laughter]", start: 1.0, end: 1.5, type: "audio_event", speaker_id: null },
        { text: "this", start: 1.5, end: 1.8, type: "word", speaker_id: "spk_1" },
        { text: "is", start: 1.8, end: 2.0, type: "word", speaker_id: "spk_1" },
        { text: "a", start: 2.0, end: 2.1, type: "word", speaker_id: "spk_1" },
        { text: "test", start: 2.1, end: 2.5, type: "word", speaker_id: "spk_1" },
      ],
      channel_index: 0,
      transcription_id: null,
      audio_duration_secs: 3.0,
    };

    const assetId = await uploadAndWriteTranscript("elevenlabs.json", elevenLabsJson);
    const response = await callReadTranscript(assetId);

    expect(response.kind).toBe("timed");
    if (response.kind !== "timed") return;
    expect(response.language_code).toBe("eng");
    expect(response.text).toBe("Hello world this is a test");
    expect(response.words).toHaveLength(6);
    expect(response.words[0]).toEqual({ text: "Hello", start: 0.0, end: 0.5, speaker_id: "spk_0" });
    expect(response.words[1]).toEqual({ text: "world", start: 0.6, end: 1.0, speaker_id: "spk_0" });
    expect(response.words[2].text).toBe("this");
  }, 30_000);

  it("returns silence when elevenlabs.json has only audio_event words", async () => {
    const elevenLabsJson = {
      language_code: "eng",
      language_probability: 0.5,
      text: "[music] [laughter]",
      words: [
        { text: "[music]", start: 0.0, end: 1.0, type: "audio_event", speaker_id: null },
        { text: "[laughter]", start: 1.0, end: 2.0, type: "audio_event", speaker_id: null },
      ],
      channel_index: 0,
      transcription_id: null,
      audio_duration_secs: 2.0,
    };

    const assetId = await uploadAndWriteTranscript("elevenlabs.json", elevenLabsJson);
    const response = await callReadTranscript(assetId);

    expect(response.kind).toBe("silence");
  }, 30_000);

  it("falls back to plain text when elevenlabs.json is absent but gpt4otrans exists", async () => {
    const plainJson = { text: "This is a plain text transcript with enough words to pass quality checks." };

    const assetId = await uploadAndWriteTranscript(".analysis.gpt4otrans.json", plainJson);
    const response = await callReadTranscript(assetId);

    expect(response.kind).toBe("plain");
    if (response.kind !== "plain") return;
    expect(response.text).toContain("plain text transcript");
  }, 30_000);

  it("returns silence when gpt4otrans has only noise tags", async () => {
    const plainJson = { text: "[music] [applause]" };

    const assetId = await uploadAndWriteTranscript(".analysis.gpt4otrans.json", plainJson);
    const response = await callReadTranscript(assetId);

    expect(response.kind).toBe("silence");
  }, 30_000);

  it("returns missing when no transcript files exist", async () => {
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: {
        book_id: "transcript-proj",
        filename: "original.mp4",
        data: Buffer.from("fake-video-data").toString("base64"),
      },
    });
    const asset = JSON.parse((uploadResult.content as TextContent)[0].text);

    const response = await callReadTranscript(asset.assetId);

    expect(response.kind).toBe("missing");
  }, 30_000);

  it("prefers timed elevenlabs.json over gpt4otrans plain text", async () => {
    const elevenLabsJson = {
      language_code: "eng",
      language_probability: 0.99,
      text: "Timed wins",
      words: [
        { text: "Timed", start: 0.0, end: 0.5, type: "word", speaker_id: "spk_0" },
        { text: "wins", start: 0.5, end: 1.0, type: "word", speaker_id: "spk_0" },
      ],
      channel_index: 0,
      transcription_id: null,
      audio_duration_secs: 1.0,
    };
    const plainJson = { text: "Plain should not win here." };

    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: {
        book_id: "transcript-proj",
        filename: "original.mp4",
        data: Buffer.from("fake-video-data").toString("base64"),
      },
    });
    const asset = JSON.parse((uploadResult.content as TextContent)[0].text);
    const assetId = asset.assetId as string;

    const timedWrite = await fs.files.write(assetId, "elevenlabs.json", JSON.stringify(elevenLabsJson, null, 2)
    );
    const plainWrite = await fs.files.write(assetId, ".analysis.gpt4otrans.json", JSON.stringify(plainJson, null, 2)
    );
    if (!timedWrite.ok) throw new Error(timedWrite.error.message);
    if (!plainWrite.ok) throw new Error(plainWrite.error.message);

    const response = await callReadTranscript(assetId);

    expect(response.kind).toBe("timed");
    if (response.kind !== "timed") return;
    expect(response.words).toHaveLength(2);
    expect(response.words[0].text).toBe("Timed");
  }, 30_000);
});

import { createEngineForTest } from "../engine.js";
import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { probeVideo, runFfmpeg } from "../ffmpeg.js";
import { registerMediaStreams } from "../jobs/process-video.js";
import { configureProviderEndpoints } from "../media/endpoints.js";
import { queue } from "../queue.js";
import type { Client } from "@modelcontextprotocol/client";
import { testBudget } from "../test-budget.js";

type TextContent = Array<{ type: string; text: string }>;

describe("transcribe tool", () => {
  let client: Client;
  let tempDir: string;
  const originalKey = process.env.ELEVENLABS_API_KEY;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;

  beforeAll(async () => {
    await queue.start();
  });

  afterAll(async () => {
    await queue.stop();
  });

  beforeEach(async () => {
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.OPENAI_API_KEY;
    tempDir = await mkdtemp(join(tmpdir(), "videocity-transcribe-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
    });
  });

  afterEach(async () => {
    if (originalKey) {
      process.env.ELEVENLABS_API_KEY = originalKey;
    } else {
      delete process.env.ELEVENLABS_API_KEY;
    }
    if (originalOpenAiKey) {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns error when no speech-to-text provider key is set", async () => {
    const result = await client.callTool({
      name: "transcribe",
      arguments: {
        asset_id: "vid-test",
        book_id: "test-proj",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("neither is set");
  });

  it("falls back to OpenAI speech-to-text for a video without an audio track file", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("video", "no-audio-sidecar");
    if (!asset.ok) throw new Error("Failed to create asset");

    await fs.files.write(asset.value.artifactId, "original.mp4", Buffer.from("fake-mp4"));

    const result = await client.callTool({
      name: "transcribe",
      arguments: {
        asset_id: asset.value.artifactId,
        book_id: "test-proj",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.provider).toBe("openai");
    expect(parsed.status).toBe("queued");
  });

  it("returns error for nonexistent asset", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";

    const result = await client.callTool({
      name: "transcribe",
      arguments: {
        asset_id: "vid-does-not-exist",
        book_id: "test-proj",
      },
    });

    expect(result.isError).toBe(true);
  });

  it("returns error when aud- asset has no audio file", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";

    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("aud", "silent");
    if (!asset.ok) throw new Error("Failed to create asset");

    // Write a non-audio file so the asset exists but has no audio
    await fs.files.write(asset.value.artifactId, "notes.txt", "hello");

    const result = await client.callTool({
      name: "transcribe",
      arguments: {
        asset_id: asset.value.artifactId,
        book_id: "test-proj",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("No audio file");
  });

  it("enqueues job with valid aud- asset containing audio", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";

    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("aud", "podcast");
    if (!asset.ok) throw new Error("Failed to create asset");

    await fs.files.write(asset.value.artifactId, "original.mp3", Buffer.from("fake-mp3"));

    const result = await client.callTool({
      name: "transcribe",
      arguments: {
        asset_id: asset.value.artifactId,
        book_id: "test-proj",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("queued");
    expect(parsed.asset_id).toBe(asset.value.artifactId);
    expect(parsed.job_id).toBeDefined();
  });

  it("wait: true surfaces the job failure as a tool error", async () => {
    // "test-key" matches the placeholder pattern, so the job's requireApiKey
    // throws before any outbound API call — failing the job deterministically.
    process.env.ELEVENLABS_API_KEY = "test-key";

    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("aud", "waitcase");
    if (!asset.ok) throw new Error("Failed to create asset");

    await fs.files.write(asset.value.artifactId, "original.mp3", Buffer.from("fake-mp3"));

    const result = await client.callTool({
      name: "transcribe",
      arguments: {
        asset_id: asset.value.artifactId,
        book_id: "test-proj",
        wait: true,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("Transcription failed");
  }, testBudget(60_000));

  describe("through the ElevenLabs endpoint override", () => {
    const speech = {
      language_code: "eng", language_probability: 0.98, text: "Hello there (laughter)", channel_index: 0,
      transcription_id: "stub-transcription", audio_duration_secs: 1,
      words: [
        { text: "Hello", start: 0.1, end: 0.4, type: "word" },
        { text: " ", start: 0.4, end: 0.45, type: "spacing" },
        { text: "there", start: 0.45, end: 0.7, type: "word" },
        { text: " ", start: 0.7, end: 0.75, type: "spacing" },
        { text: "(laughter)", start: 0.75, end: 1, type: "audio_event" },
      ],
    };
    let requests: { method: string; url: string; contentType: string; body: Buffer }[];
    let scratch: string;
    let restoreEndpoints: () => void;
    const stub = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({
          method: request.method ?? "", url: request.url ?? "", contentType: String(request.headers["content-type"] ?? ""),
          body: Buffer.concat(chunks),
        });
        if (request.url !== "/v1/speech-to-text") {
          response.statusCode = 404;
          response.end();
          return;
        }
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(speech));
      });
    });

    beforeAll(() => new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve)));
    afterAll(() => new Promise<void>((resolve) => stub.close(() => resolve())));
    beforeEach(async () => {
      requests = [];
      scratch = await mkdtemp(join(tmpdir(), "videocity-transcribe-audio-"));
      process.env.ELEVENLABS_API_KEY = "offline-elevenlabs-key";
      restoreEndpoints = configureProviderEndpoints({
        elevenlabsBaseURL: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`,
      });
    });
    afterEach(async () => {
      restoreEndpoints();
      await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
    });

    it("sends the requested settings through the real transcribe job and stores the word-timed transcript", async () => {
      const fs = createEngineForTest(tempDir);
      const asset = await fs.artifacts.create("audio", "interview");
      if (!asset.ok) throw new Error(asset.error.message);
      const assetId = asset.value.artifactId;
      const media = join(scratch, "interview.mp3");
      await runFfmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libmp3lame", "-b:a", "64k", media]);
      const saved = await fs.files.writeFromPath(assetId, "original.mp3", media);
      if (!saved.ok) throw new Error(saved.error.message);
      const mediaProbe = await probeVideo(media);
      await registerMediaStreams(fs, assetId, "original.mp3", mediaProbe);
      const settings = { asset_id: assetId, book_id: "test-proj", language_code: "en", diarize: false };

      const result = await client.callTool({ name: "transcribe", arguments: { ...settings, wait: true } });

      expect(result.isError).toBeFalsy();
      expect(JSON.parse((result.content as TextContent)[0].text)).toMatchObject({
        asset_id: assetId, provider: "elevenlabs", status: "completed",
      });
      expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual(["POST /v1/speech-to-text"]);
      const form = await new Response(new Uint8Array(requests[0].body), { headers: { "content-type": requests[0].contentType } }).formData();
      expect(Object.fromEntries([...form].filter(([, value]) => typeof value === "string"))).toEqual({
        model_id: "scribe_v2", tag_audio_events: "true", diarize: "false", language_code: "en",
      });
      const file = form.get("file") as File;
      expect(file.type).toBe("audio/mpeg");
      expect(Buffer.from(await file.arrayBuffer())).toEqual(await readFile(media));

      const sidecar = await fs.files.read(assetId, "elevenlabs.json");
      if (!sidecar.ok) throw new Error(sidecar.error.message);
      expect(JSON.parse(sidecar.value.toString("utf8"))).toEqual(speech);
      const streams = fs.streams.list(assetId);
      if (!streams.ok) throw new Error(streams.error.message);
      const transcripts = await fs.transcripts.list(assetId);
      if (!transcripts.ok) throw new Error(transcripts.error.message);
      expect(transcripts.value).toEqual([
        expect.objectContaining({ streamId: streams.value[0].streamId, language: "en", provider: "elevenlabs", model: "scribe_v2" }),
      ]);
      expect(transcripts.value[0].segments.map(({ kind, text, words }) => ({ kind, text, words: words.map((word) => word.text) }))).toEqual([
        { kind: "speech", text: "Hello there", words: ["Hello", "there"] },
        { kind: "sound", text: "(laughter)", words: [] },
      ]);
      const seconds = mediaProbe.audioDuration ?? mediaProbe.duration;
      const usage = fs.usage.recent(10).find((row) => row.model === "scribe_v2");
      expect(usage).toMatchObject({
        provider: "elevenlabs", basis: "estimated", unit: "seconds", status: "completed", operation: "transcribe", warnings: [],
      });
      expect(usage?.units).toBeCloseTo(seconds, 3);
      expect(usage?.costUsd).toBeCloseTo(seconds * 0.22 / 3600, 6);

      const again = await client.callTool({ name: "transcribe", arguments: settings });
      expect(JSON.parse((again.content as TextContent)[0].text)).toMatchObject({ status: "cached", job_id: null });
      expect(requests).toHaveLength(1);
    }, testBudget(60_000));
  });
});

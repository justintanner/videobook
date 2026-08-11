import { createElevenLabs } from "@apicity/elevenlabs";
import type { Engine } from "videobook-engine";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeEngineForTest, createEngineForTest } from "../fs.js";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import { queue, setEngineRoot } from "../queue.js";
import {
  registerReplicateSongJob,
  replicateSongWithElevenLabs,
  type ReplicateSongPayload,
} from "./replicate-song.js";

const execFileAsync = promisify(execFile);
const TARGET_DURATION_MS = 22_010;
const TARGET_SAMPLES = 1_056_480;

type CapturedRequest = {
  body: Buffer;
  contentType: string;
  url: string;
};

function uploadedWav(body: Buffer): Buffer {
  const start = body.indexOf(Buffer.from("RIFF"));
  if (start < 0 || start + 8 > body.length) throw new Error("Multipart upload has no WAV payload");
  const length = body.readUInt32LE(start + 4) + 8;
  return body.subarray(start, start + length);
}

function wavPcmData(wav: Buffer): Buffer {
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const kind = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (kind === "data") return wav.subarray(dataStart, dataStart + size);
    offset = dataStart + size + size % 2;
  }
  throw new Error("Uploaded WAV has no PCM data chunk");
}

function peakPcm16(pcm: Buffer): number {
  let peak = 0;
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    peak = Math.max(peak, Math.abs(pcm.readInt16LE(offset)));
  }
  return peak;
}

async function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address !== null) resolve(address.port);
      else reject(new Error("Local ElevenLabs server has no TCP address"));
    });
  });
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function createElevenLabsServer(
  generatedAudio: Buffer,
  captured: CapturedRequest[],
  options: { uploadStatus?: number } = {},
): Server {
  return createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const entry = {
        body: Buffer.concat(chunks),
        contentType: String(request.headers["content-type"] ?? ""),
        url: request.url ?? "",
      };
      captured.push(entry);
      if (request.url === "/v1/music/upload") {
        if (options.uploadStatus !== undefined) {
          response.statusCode = options.uploadStatus;
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ detail: "reference rejected" }));
          return;
        }
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ song_id: "song-source-123" }));
        return;
      }
      if (request.url?.startsWith("/v1/music?")) {
        response.setHeader("Content-Type", "audio/mpeg");
        response.end(generatedAudio);
        return;
      }
      response.statusCode = 404;
      response.end();
    });
  });
}

describe("replicate song ElevenLabs job", () => {
  let fixtureDir: string;
  let sourceVideo: Buffer;
  let generatedAudio: Buffer;
  let shortGeneratedAudio: Buffer;
  let engineRoot: string;
  let fs: Engine;
  let sourceAssetId: string;
  let outputAssetId: string;
  let server: Server | undefined;

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "videobook-replicate-song-fixture-"));
    const sourcePath = join(fixtureDir, "source.mp4");
    const generatedPath = join(fixtureDir, "generated.mp3");
    const shortGeneratedPath = join(fixtureDir, "generated-short.mp3");
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "color=c=black:s=32x32:r=2:d=22.01",
      "-itsoffset", "0.978",
      "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=22.01",
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-shortest",
      sourcePath,
    ]);
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=22.01",
      "-c:a", "libmp3lame",
      "-b:a", "192k",
      generatedPath,
    ]);
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=21.5",
      "-c:a", "libmp3lame",
      "-b:a", "192k",
      shortGeneratedPath,
    ]);
    [sourceVideo, generatedAudio, shortGeneratedAudio] = await Promise.all([
      readFile(sourcePath),
      readFile(generatedPath),
      readFile(shortGeneratedPath),
    ]);
  }, 60_000);

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true, maxRetries: 3 });
  });

  beforeEach(async () => {
    engineRoot = await mkdtemp(join(tmpdir(), "videobook-replicate-song-engine-"));
    fs = createEngineForTest(engineRoot);
    const source = await fs.artifacts.create("video", "source clip");
    const output = await fs.artifacts.create("audio", "replicated song");
    if (!source.ok) throw new Error(source.error.message);
    if (!output.ok) throw new Error(output.error.message);
    sourceAssetId = source.value.artifactId;
    outputAssetId = output.value.artifactId;
    const written = await fs.files.write(sourceAssetId, "original.mp4", sourceVideo);
    if (!written.ok) throw new Error(written.error.message);
  });

  afterEach(async () => {
    await closeServer(server);
    server = undefined;
    closeEngineForTest(engineRoot, fs);
    await rm(engineRoot, { recursive: true, force: true, maxRetries: 3 });
  });

  function payload(direction?: string): ReplicateSongPayload {
    return {
      type: "generate_replicated_song",
      audAssetId: outputAssetId,
      sourceAssetId,
      sourceFilename: "original.mp4",
      targetDurationMs: TARGET_DURATION_MS,
      direction,
      bookId: fs.book.get().bookId,
    };
  }

  it("uploads an exact reference, sends one conditioned Music v2 chunk, and persists an exact WAV", async () => {
    const captured: CapturedRequest[] = [];
    server = createElevenLabsServer(generatedAudio, captured);
    const port = await listen(server);
    const provider = createElevenLabs({
      apiKey: "test-elevenlabs-key",
      baseURL: `http://127.0.0.1:${port}`,
      timeout: 30_000,
    });

    const result = await replicateSongWithElevenLabs(
      fs,
      payload("Keep the strings bright and the drums dry."),
      provider,
    );

    expect(result).toMatchObject({
      duration: 22.01,
      durationTicks: TARGET_SAMPLES,
      songId: "song-source-123",
    });
    expect(captured).toHaveLength(2);
    const upload = captured[0];
    expect(upload.url).toBe("/v1/music/upload");
    expect(upload.contentType).toContain("multipart/form-data");
    expect(upload.body.includes(Buffer.from("audio/wav"))).toBe(true);
    expect(upload.body.includes(Buffer.from("RIFF"))).toBe(true);
    expect(upload.body.includes(Buffer.from("extract_composition_plan"))).toBe(false);
    expect(upload.body.includes(Buffer.from("with_timestamps"))).toBe(false);
    const referencePcm = wavPcmData(uploadedWav(upload.body));
    const bytesPerSecond = 48_000 * 2 * 2;
    expect(referencePcm).toHaveLength(TARGET_SAMPLES * 2 * 2);
    expect(peakPcm16(referencePcm.subarray(0, bytesPerSecond / 2))).toBe(0);
    expect(peakPcm16(referencePcm.subarray(
      Math.round(bytesPerSecond * 1.1),
      Math.round(bytesPerSecond * 1.6),
    ))).toBeGreaterThan(100);

    const compose = captured[1];
    expect(compose.url).toBe("/v1/music?output_format=mp3_48000_192");
    expect(compose.contentType).toBe("application/json");
    const body = JSON.parse(compose.body.toString("utf8")) as Record<string, unknown>;
    expect(body).not.toHaveProperty("prompt");
    expect(body).not.toHaveProperty("music_length_ms");
    expect(body).not.toHaveProperty("force_instrumental");
    expect(body.model_id).toBe("music_v2");
    expect(body.composition_plan).toEqual({
      chunks: [{
        text: "Create a new instrumental using only drums and a string ensemble. Follow the uploaded reference as strongly as possible for tempo, groove, rhythmic accents, and phrase timing. Start immediately at full musical activity. An optional direction may refine those qualities but must not add vocals or other instruments. Keep the strings bright and the drums dry.",
        duration_ms: TARGET_DURATION_MS,
        positive_styles: [
          "instrumental",
          "drums and string ensemble only",
          "preserve source tempo",
          "preserve source groove",
          "preserve rhythmic accents",
          "preserve phrase timing",
          "immediate start",
          "strongest audio-reference following",
        ],
        negative_styles: [
          "vocals",
          "speech",
          "choir",
          "piano",
          "guitar",
          "bass guitar",
          "synth",
          "brass",
          "woodwinds",
          "effects",
          "ambience",
        ],
        context_adherence: "high",
        conditioning_ref: {
          song_id: "song-source-123",
          range: { start_ms: 0, end_ms: TARGET_DURATION_MS },
        },
        condition_strength: "xhigh",
      }],
    });

    const manifest = await fs.files.manifest(outputAssetId);
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    expect(manifest.value.files.map((file) => file.name)).toEqual(["original.wav"]);
    const outputPath = join(manifest.value.path, "original.wav");
    const probe = await probeVideo(outputPath);
    expect(probe.audioDuration).toBe(22.01);
    expect(probe.audioCodec).toBe("pcm_s16le");
    expect(probe.audioStream).toMatchObject({
      durationTicks: TARGET_SAMPLES,
      timeBase: { numerator: 1, denominator: 48_000 },
      audio: {
        sampleRateHz: 48_000,
        channels: 2,
        channelLayout: "stereo",
      },
    });

    const streams = fs.streams.list(outputAssetId);
    expect(streams.ok).toBe(true);
    if (streams.ok) {
      expect(streams.value).toEqual([
        expect.objectContaining({
          sourcePath: "original.wav",
          kind: "audio",
          codec: "pcm_s16le",
          durationTicks: TARGET_SAMPLES,
          timeBase: { numerator: 1, denominator: 48_000 },
          audio: {
            sampleRateHz: 48_000,
            channels: 2,
            channelLayout: "stereo",
          },
        }),
      ]);
    }
    const waveform = await fs.metadata.waveforms.read(outputAssetId);
    expect(waveform.ok).toBe(true);
    if (waveform.ok) expect(waveform.value.peaks.length).toBeGreaterThan(0);
    const metadata = await fs.metadata.artifacts.read(outputAssetId, "original");
    expect(metadata.ok).toBe(true);
    if (metadata.ok) {
      expect(metadata.value).toMatchObject({
        origin: "replicate_song",
        provider: "elevenlabs",
        model: "music_v2",
        output_format: "mp3_48000_192",
        source_asset: sourceAssetId,
        source_filename: "original.mp4",
        conditioning_song_id: "song-source-123",
        conditioning_strength: "xhigh",
        context_adherence: "high",
        arrangement: "drums_and_strings",
        direction: "Keep the strings bright and the drums dry.",
        target_duration_ms: TARGET_DURATION_MS,
        duration: 22.01,
        target_samples_per_channel: TARGET_SAMPLES,
        instrumental_requested: true,
        sampleRateHz: 48_000,
        channels: 2,
      });
    }
    const sourceManifest = await fs.files.manifest(sourceAssetId);
    expect(sourceManifest.ok && sourceManifest.value.files.map((file) => file.name)).toEqual(["original.mp4"]);
  }, 60_000);

  it("rejects provider audio more than 250ms short without persisting output or leaking scratch", async () => {
    const captured: CapturedRequest[] = [];
    server = createElevenLabsServer(shortGeneratedAudio, captured);
    const port = await listen(server);
    const provider = createElevenLabs({
      apiKey: "test-elevenlabs-key",
      baseURL: `http://127.0.0.1:${port}`,
      timeout: 30_000,
    });
    const before = new Set(
      (await readdir(tmpdir())).filter((name) => name.startsWith("videobook-replicate-song-")),
    );

    await expect(replicateSongWithElevenLabs(fs, payload(), provider)).rejects.toThrow(
      "maximum allowed shortfall is 0.250s",
    );

    const after = (await readdir(tmpdir())).filter((name) =>
      name.startsWith("videobook-replicate-song-") && !before.has(name));
    expect(after).toEqual([]);
    const manifest = await fs.files.manifest(outputAssetId);
    expect(manifest.ok && manifest.value.files).toEqual([]);
  }, 60_000);

  it("stops after an upload rejection without composing, persisting output, or leaking scratch", async () => {
    const captured: CapturedRequest[] = [];
    server = createElevenLabsServer(generatedAudio, captured, { uploadStatus: 422 });
    const port = await listen(server);
    const provider = createElevenLabs({
      apiKey: "test-elevenlabs-key",
      baseURL: `http://127.0.0.1:${port}`,
      timeout: 30_000,
    });
    const before = new Set(
      (await readdir(tmpdir())).filter((name) => name.startsWith("videobook-replicate-song-")),
    );

    await expect(replicateSongWithElevenLabs(fs, payload(), provider)).rejects.toThrow();

    expect(captured.map((request) => request.url)).toEqual(["/v1/music/upload"]);
    const after = (await readdir(tmpdir())).filter((name) =>
      name.startsWith("videobook-replicate-song-") && !before.has(name));
    expect(after).toEqual([]);
    const manifest = await fs.files.manifest(outputAssetId);
    expect(manifest.ok && manifest.value.files).toEqual([]);
  }, 60_000);

  it.each([9_999, 30_001])("rejects out-of-contract duration %sms before provider upload", async (targetDurationMs) => {
    const captured: CapturedRequest[] = [];
    server = createElevenLabsServer(generatedAudio, captured);
    const port = await listen(server);
    const provider = createElevenLabs({
      apiKey: "test-elevenlabs-key",
      baseURL: `http://127.0.0.1:${port}`,
      timeout: 30_000,
    });

    await expect(replicateSongWithElevenLabs(
      fs,
      { ...payload(), targetDurationMs },
      provider,
    )).rejects.toThrow("10000 to 30000 milliseconds");

    expect(captured).toEqual([]);
  });

  it("marks a provider setup failure as a single-attempt generation error", async () => {
    const originalKey = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    await setEngineRoot(engineRoot, fs);
    registerReplicateSongJob(fs);
    const jobId = `replicate-song-failure-${Date.now()}`;
    try {
      await expect(queue.enqueueAndWait(jobId, payload(), 30_000)).rejects.toThrow(
        "ELEVENLABS_API_KEY environment variable is not set",
      );
      const status = await fs.status.get(outputAssetId);
      expect(status.ok && status.value).toBe("error");
      const job = fs.jobs.queue.list({
        artifactId: outputAssetId,
        states: ["failed"],
      })[0];
      expect(job).toMatchObject({
        type: "generate_replicated_song",
        state: "failed",
        attempts: 1,
        maxAttempts: 1,
      });
    } finally {
      await queue.stop();
      if (originalKey === undefined) delete process.env.ELEVENLABS_API_KEY;
      else process.env.ELEVENLABS_API_KEY = originalKey;
    }
  });
});

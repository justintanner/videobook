import type { Engine } from "videobook-engine";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseMultipartMixed } from "../acestep/client.js";
import { resetAceStepForTests } from "../acestep/process.js";
import { closeEngineForTest, createEngineForTest } from "../fs.js";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import { queue, setEngineRoot } from "../queue.js";
import {
  coverSongWithAcestep,
  registerAcestepCoverJob,
  type AcestepCoverPayload,
} from "./generate-acestep-cover.js";

const execFileAsync = promisify(execFile);
const TARGET_DURATION_MS = 22_010;
const TARGET_SAMPLES = 1_056_480;
const STUB_BOUNDARY = "ace-batch-boundary";
const SCRATCH_PREFIX = "videobook-acestep-cover-";
const BASE_CAPTION = "instrumental cover, drums and string ensemble only, cinematic strings, punchy drums, follows the source rhythm and phrasing, immediate start, no vocals";

type CapturedRequest = {
  method: string;
  url: string;
  contentType: string;
  body: Buffer;
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

function multipartField(body: Buffer, contentType: string, name: string): Buffer {
  const boundary = /boundary="?([^";]+)"?/u.exec(contentType)?.[1];
  if (!boundary) throw new Error("Captured request has no multipart boundary");
  const marker = Buffer.from(`name="${name}"`);
  const start = body.indexOf(marker);
  if (start < 0) throw new Error(`Captured request has no "${name}" field`);
  const dataStart = body.indexOf("\r\n\r\n", start) + 4;
  const end = body.indexOf(`\r\n--${boundary}`, dataStart);
  if (dataStart < 4 || end < 0) throw new Error(`Captured "${name}" field is malformed`);
  return body.subarray(dataStart, end);
}

function multipartMixedBody(
  parts: Array<{ contentType: string; data: Buffer }>,
  boundary: string,
): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Type: ${part.contentType}\r\n\r\n`),
      part.data,
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

async function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address !== null) resolve(address.port);
      else reject(new Error("Stub ace-server has no TCP address"));
    });
  });
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function createAceStepServer(
  generatedAudio: Buffer,
  captured: CapturedRequest[],
  options: { statuses?: string[] } = {},
): Server {
  const statuses = [...(options.statuses ?? [])];
  return createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      captured.push({
        method: request.method ?? "",
        url: request.url ?? "",
        contentType: String(request.headers["content-type"] ?? ""),
        body: Buffer.concat(chunks),
      });
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const respondJson = (value: unknown): void => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(value));
      };
      if (request.method === "GET" && url.pathname === "/health") {
        respondJson({ status: "ok" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/props") {
        respondJson({ models: { lm: [], embedding: [], dit: [], vae: [] } });
        return;
      }
      if (request.method === "POST" && url.pathname === "/synth") {
        respondJson({ id: "ace-job-1" });
        return;
      }
      if (url.pathname === "/job" && request.method === "POST" && url.searchParams.get("cancel") === "1") {
        respondJson({ status: "cancelled" });
        return;
      }
      if (url.pathname === "/job" && request.method === "GET" && url.searchParams.get("result") === "1") {
        const body = multipartMixedBody([
          { contentType: "audio/wav", data: generatedAudio },
          { contentType: "application/octet-stream", data: Buffer.alloc(550 * 256) },
        ], STUB_BOUNDARY);
        response.setHeader("Content-Type", `multipart/mixed; boundary=${STUB_BOUNDARY}`);
        response.end(body);
        return;
      }
      if (url.pathname === "/job" && request.method === "GET") {
        respondJson({ status: statuses.shift() ?? "done" });
        return;
      }
      response.statusCode = 404;
      response.end();
    });
  });
}

async function scratchDirs(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith(SCRATCH_PREFIX));
}

describe("generate acestep cover job", () => {
  let fixtureDir: string;
  let sourceVideo: Buffer;
  let generatedAudio: Buffer;
  let shortGeneratedAudio: Buffer;
  let engineRoot: string;
  let fs: Engine;
  let sourceAssetId: string;
  let outputAssetId: string;
  let server: Server | undefined;
  let savedEnv: Record<string, string | undefined>;

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "videobook-acestep-fixture-"));
    const sourcePath = join(fixtureDir, "source.mp4");
    const generatedPath = join(fixtureDir, "generated.wav");
    const shortGeneratedPath = join(fixtureDir, "generated-short.wav");
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
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=22.01",
      "-af", "aformat=sample_fmts=s16:channel_layouts=stereo",
      "-c:a", "pcm_s16le",
      "-ar", "48000",
      "-ac", "2",
      generatedPath,
    ]);
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=21.5",
      "-af", "aformat=sample_fmts=s16:channel_layouts=stereo",
      "-c:a", "pcm_s16le",
      "-ar", "48000",
      "-ac", "2",
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
    savedEnv = {
      VIDEOBOOK_ACESTEP_BASE_URL: process.env.VIDEOBOOK_ACESTEP_BASE_URL,
      VIDEOBOOK_ACESTEP_SERVER_PATH: process.env.VIDEOBOOK_ACESTEP_SERVER_PATH,
      VIDEOBOOK_ACESTEP_MODELS_DIR: process.env.VIDEOBOOK_ACESTEP_MODELS_DIR,
      VIDEOBOOK_ACESTEP_PORT: process.env.VIDEOBOOK_ACESTEP_PORT,
    };
    engineRoot = await mkdtemp(join(tmpdir(), "videobook-acestep-engine-"));
    fs = createEngineForTest(engineRoot);
    const source = await fs.artifacts.create("video", "source clip");
    const output = await fs.artifacts.create("audio", "cover song");
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
    resetAceStepForTests();
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    closeEngineForTest(engineRoot, fs);
    await rm(engineRoot, { recursive: true, force: true, maxRetries: 3 });
  });

  function payload(direction?: string): AcestepCoverPayload {
    return {
      type: "generate_acestep_cover",
      audAssetId: outputAssetId,
      sourceAssetId,
      sourceFilename: "original.mp4",
      targetDurationMs: TARGET_DURATION_MS,
      direction,
      bookId: fs.book.get().bookId,
    };
  }

  async function startStub(
    audio: Buffer,
    captured: CapturedRequest[],
    options: { statuses?: string[] } = {},
  ): Promise<void> {
    server = createAceStepServer(audio, captured, options);
    const port = await listen(server);
    process.env.VIDEOBOOK_ACESTEP_BASE_URL = `http://127.0.0.1:${port}`;
  }

  it("submits one cover synth job with an exact reference and persists an exact WAV", async () => {
    const captured: CapturedRequest[] = [];
    await startStub(generatedAudio, captured, { statuses: ["running", "done"] });

    const result = await coverSongWithAcestep(fs, payload("Keep the strings bright and the drums dry."));

    expect(result).toMatchObject({
      duration: 22.01,
      durationTicks: TARGET_SAMPLES,
    });
    expect(Number.isInteger(result.seed)).toBe(true);
    expect(result.seed).toBeGreaterThanOrEqual(0);

    const synthCalls = captured.filter((entry) => entry.method === "POST" && entry.url === "/synth");
    expect(synthCalls).toHaveLength(1);
    const synth = synthCalls[0];
    expect(synth.contentType).toContain("multipart/form-data");
    expect(synth.body.includes(Buffer.from('name="request"'))).toBe(true);
    expect(synth.body.includes(Buffer.from('name="audio"'))).toBe(true);

    const referencePcm = wavPcmData(uploadedWav(synth.body));
    const bytesPerSecond = 48_000 * 2 * 2;
    expect(referencePcm).toHaveLength(TARGET_SAMPLES * 2 * 2);
    expect(peakPcm16(referencePcm.subarray(0, bytesPerSecond / 2))).toBe(0);
    expect(peakPcm16(referencePcm.subarray(
      Math.round(bytesPerSecond * 1.1),
      Math.round(bytesPerSecond * 1.6),
    ))).toBeGreaterThan(100);

    const requestJson = JSON.parse(
      multipartField(synth.body, synth.contentType, "request").toString("utf8"),
    ) as Record<string, unknown>;
    expect(requestJson).toEqual({
      caption: `${BASE_CAPTION}, Keep the strings bright and the drums dry.`,
      lyrics: "[Instrumental]",
      task_type: "cover",
      output_format: "wav16",
      seed: result.seed,
      inference_steps: 0,
      audio_cover_strength: 1,
      synth_batch_size: 1,
      synth_model: "acestep-v15-turbo-Q4_K_M.gguf",
      duration: 0,
    });

    const jobPolls = captured.filter((entry) => entry.method === "GET" && entry.url.startsWith("/job"));
    expect(jobPolls.length).toBeGreaterThanOrEqual(3);
    expect(jobPolls.at(-1)?.url).toContain("result=1");

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
        origin: "make_cover_song",
        provider: "acestep.cpp",
        model: "acestep-v15-turbo-Q4_K_M.gguf",
        task_type: "cover",
        output_format: "wav16",
        audio_cover_strength: 1,
        inference_steps: 0,
        seed: result.seed,
        caption: `${BASE_CAPTION}, Keep the strings bright and the drums dry.`,
        lyrics: "[Instrumental]",
        arrangement: "drums_and_strings",
        source_asset: sourceAssetId,
        source_filename: "original.mp4",
        direction: "Keep the strings bright and the drums dry.",
        target_duration_ms: TARGET_DURATION_MS,
        duration: 22.01,
        target_samples_per_channel: TARGET_SAMPLES,
        instrumental_requested: true,
        sampleRateHz: 48_000,
        channels: 2,
      });
      expect(metadata.value).not.toHaveProperty("conditioning_song_id");
      expect(metadata.value).not.toHaveProperty("conditioning_strength");
      expect(metadata.value).not.toHaveProperty("context_adherence");
    }
    const sourceManifest = await fs.files.manifest(sourceAssetId);
    expect(sourceManifest.ok && sourceManifest.value.files.map((file) => file.name)).toEqual(["original.mp4"]);
  }, 60_000);

  it("rejects generated audio more than 250ms short without persisting output or leaking scratch", async () => {
    const captured: CapturedRequest[] = [];
    await startStub(shortGeneratedAudio, captured);
    const before = new Set(await scratchDirs());

    await expect(coverSongWithAcestep(fs, payload())).rejects.toThrow(
      "maximum allowed shortfall is 0.250s",
    );

    const after = (await scratchDirs()).filter((name) => !before.has(name));
    expect(after).toEqual([]);
    const manifest = await fs.files.manifest(outputAssetId);
    expect(manifest.ok && manifest.value.files).toEqual([]);
  }, 60_000);

  it("fails when ace-server reports the synth job as failed, without persisting output", async () => {
    const captured: CapturedRequest[] = [];
    await startStub(generatedAudio, captured, { statuses: ["running", "failed"] });
    const before = new Set(await scratchDirs());

    await expect(coverSongWithAcestep(fs, payload())).rejects.toThrow(
      "reported the cover synthesis job as failed",
    );

    expect(captured.filter((entry) => entry.url.includes("result=1"))).toEqual([]);
    const after = (await scratchDirs()).filter((name) => !before.has(name));
    expect(after).toEqual([]);
    const manifest = await fs.files.manifest(outputAssetId);
    expect(manifest.ok && manifest.value.files).toEqual([]);
  }, 60_000);

  it("fails fast when no ace-server is reachable at the configured base URL", async () => {
    process.env.VIDEOBOOK_ACESTEP_BASE_URL = "http://127.0.0.1:1";
    const before = new Set(await scratchDirs());

    await expect(coverSongWithAcestep(fs, payload())).rejects.toThrow("is not responding");

    const after = (await scratchDirs()).filter((name) => !before.has(name));
    expect(after).toEqual([]);
    const manifest = await fs.files.manifest(outputAssetId);
    expect(manifest.ok && manifest.value.files).toEqual([]);
  }, 60_000);

  it.each([9_999, 240_001])("rejects out-of-contract duration %sms before contacting ace-server", async (targetDurationMs) => {
    const captured: CapturedRequest[] = [];
    await startStub(generatedAudio, captured);

    await expect(coverSongWithAcestep(
      fs,
      { ...payload(), targetDurationMs },
    )).rejects.toThrow("10000 to 240000 milliseconds");

    expect(captured).toEqual([]);
  });

  it("marks a missing local runtime as a single-attempt generation error", async () => {
    process.env.VIDEOBOOK_ACESTEP_SERVER_PATH = "/nonexistent/ace-server";
    process.env.VIDEOBOOK_ACESTEP_MODELS_DIR = "/nonexistent/acestep-models";
    process.env.VIDEOBOOK_ACESTEP_PORT = "1";
    delete process.env.VIDEOBOOK_ACESTEP_BASE_URL;
    await setEngineRoot(engineRoot, fs);
    registerAcestepCoverJob(fs);
    const jobId = `acestep-cover-failure-${Date.now()}`;
    try {
      await expect(queue.enqueueAndWait(jobId, payload(), 30_000)).rejects.toThrow(
        "ace-server not found at /nonexistent/ace-server",
      );
      const status = await fs.status.get(outputAssetId);
      expect(status.ok && status.value).toBe("error");
      const job = fs.jobs.queue.list({
        artifactId: outputAssetId,
        states: ["failed"],
      })[0];
      expect(job).toMatchObject({
        type: "generate_acestep_cover",
        state: "failed",
        attempts: 1,
        maxAttempts: 1,
      });
    } finally {
      await queue.stop();
    }
  });

  it("parses multipart/mixed bodies and rejects malformed ones", () => {
    const audio = Buffer.from("RIFF-fake-audio");
    const latents = Buffer.alloc(512);
    const body = multipartMixedBody([
      { contentType: "audio/wav", data: audio },
      { contentType: "application/octet-stream", data: latents },
    ], STUB_BOUNDARY);

    const parts = parseMultipartMixed(body, `multipart/mixed; boundary=${STUB_BOUNDARY}`);
    expect(parts).toHaveLength(2);
    expect(parts[0].headers["content-type"]).toBe("audio/wav");
    expect(parts[0].data.equals(audio)).toBe(true);
    expect(parts[1].headers["content-type"]).toBe("application/octet-stream");
    expect(parts[1].data.equals(latents)).toBe(true);

    expect(() => parseMultipartMixed(body, "application/json")).toThrow("no multipart boundary");
    expect(() => parseMultipartMixed(
      Buffer.from(`--${STUB_BOUNDARY}\r\nContent-Type: audio/wav\r\n\r\ntruncated`),
      `multipart/mixed; boundary=${STUB_BOUNDARY}`,
    )).toThrow("truncated");
  });
});

import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createElevenLabs } from "@apicity/elevenlabs";
import { createFs, type VideocityFs } from "videocity-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import {
  extendAudioWithElevenLabs,
  fillLoopableContinuation,
  hasAudibleContinuationTail,
  type ExtendAudioPayload,
} from "./extend-audio.js";

const execFileAsync = promisify(execFile);
const PROJECT_SLUG = "extend-audio-test";

type CapturedRequest = {
  contentType: string;
  body: Buffer;
  url: string;
};

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

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

describe("extend audio ElevenLabs job", () => {
  let tempDir: string;
  let fs: VideocityFs;
  let server: Server;
  let sourceAudio: Buffer;
  let continuationAudio: Buffer;
  let transcribeRequest: CapturedRequest | null;
  let soundRequest: CapturedRequest | null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-extend-audio-"));
    const sourcePath = join(tempDir, "source.mp3");
    const continuationPath = join(tempDir, "continuation.mp3");
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi",
      "-i", "sine=frequency=440:duration=6.048:sample_rate=48000",
      "-c:a", "libmp3lame",
      "-b:a", "192k",
      sourcePath,
    ]);
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi",
      "-i", "sine=frequency=880:duration=9.452:sample_rate=44100",
      "-c:a", "libmp3lame",
      "-b:a", "128k",
      continuationPath,
    ]);
    sourceAudio = await readFile(sourcePath);
    continuationAudio = await readFile(continuationPath);
    transcribeRequest = null;
    soundRequest = null;

    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const captured = {
          contentType: String(request.headers["content-type"] ?? ""),
          body: Buffer.concat(chunks),
          url: request.url ?? "",
        };
        if (request.url === "/v1/speech-to-text") {
          transcribeRequest = captured;
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({
            language_code: "eng",
            language_probability: 0.99,
            text: "[horse neighing]",
            words: [{
              text: "[horse neighing]",
              start: 0.1,
              end: 4.5,
              type: "audio_event",
              speaker_id: null,
            }],
            channel_index: 0,
            transcription_id: "transcript-source-123",
            audio_duration_secs: 6.048,
          }));
          return;
        }
        if (request.url?.startsWith("/v1/sound-generation?")) {
          soundRequest = captured;
          response.setHeader("Content-Type", "audio/mpeg");
          response.end(continuationAudio);
          return;
        }
        response.statusCode = 404;
        response.end();
      });
    });

    fs = createFs({ projectsDir: join(tempDir, "projects") });
    const project = await fs.createProject(PROJECT_SLUG);
    if (!project.ok) throw new Error(project.error.message);
  });

  afterEach(async () => {
    fs.close();
    await closeServer(server);
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("describes the source, generates its continuation, crossfades it, and writes a 15s aud-* asset", async () => {
    const source = await fs.createAsset("aud", "source", PROJECT_SLUG);
    const output = await fs.createAsset("aud", "extended", PROJECT_SLUG);
    if (!source.ok) throw new Error(source.error.message);
    if (!output.ok) throw new Error(output.error.message);
    const sourceWrite = await fs.writeFile(source.value.assetId, "original.mp3", sourceAudio, PROJECT_SLUG);
    if (!sourceWrite.ok) throw new Error(sourceWrite.error.message);

    const port = await listen(server);
    const provider = createElevenLabs({
      apiKey: "test-elevenlabs-key",
      baseURL: `http://127.0.0.1:${port}`,
      timeout: 30_000,
    });
    const payload: ExtendAudioPayload = {
      type: "extend_audio",
      audAssetId: output.value.assetId,
      sourceAssetId: source.value.assetId,
      sourceFilename: "original.mp3",
      sourceDurationMs: 6_048,
      targetDurationMs: 15_000,
      projectSlug: PROJECT_SLUG,
    };

    const result = await extendAudioWithElevenLabs(fs, payload, provider);

    expect(result.sourceDescription).toBe("horse neighing");
    expect(result.duration).toBeCloseTo(15, 1);
    expect(result.generationAttempts).toBe(1);
    expect(result.loopFilled).toBe(false);
    expect(transcribeRequest?.contentType).toContain("multipart/form-data");
    expect(transcribeRequest?.body.includes(Buffer.from("scribe_v2"))).toBe(true);
    expect(transcribeRequest?.body.includes(Buffer.from("filename=\"blob\""))).toBe(true);
    expect(soundRequest?.url).toContain("output_format=mp3_44100_128");
    expect(soundRequest?.contentType).toBe("application/json");

    const soundBody = JSON.parse(soundRequest?.body.toString("utf8") ?? "{}") as {
      text?: string;
      model_id?: string;
      duration_seconds?: number;
      prompt_influence?: number;
      loop?: boolean;
    };
    expect(soundBody).toMatchObject({
      model_id: "eleven_text_to_sound_v2",
      duration_seconds: 9.452,
      prompt_influence: 0.9,
      loop: false,
    });
    expect(soundBody.text).toContain("horse neighing");
    expect(soundBody.text).toContain("Continue this audio seamlessly for 9.5s");
    expect(soundBody.text).toContain("Start immediately mid-action");
    expect(soundBody.text).toContain("Repeat or vary the source event naturally");
    expect(soundBody.text).toContain("No intro, unrelated sound, fade-in, early ending, or silent tail");
    expect(soundBody.text?.length).toBeLessThanOrEqual(450);

    const written = await fs.readFile(output.value.assetId, "original.mp3", PROJECT_SLUG);
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.value).not.toEqual(sourceAudio);
    expect(written.value).not.toEqual(continuationAudio);
    const manifest = await fs.getManifest(output.value.assetId, PROJECT_SLUG, { includeDotfiles: true });
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    const probe = await probeVideo(join(manifest.value.path, "original.mp3"));
    expect(probe.audioDuration).toBeCloseTo(15, 1);

    const metadata = await fs.readMetadata(output.value.assetId, "original", PROJECT_SLUG);
    expect(metadata.ok).toBe(true);
    if (metadata.ok) {
      expect(metadata.value).toMatchObject({
        origin: "elevenlabs_sound_generation_extend",
        transcription_model: "scribe_v2",
        generation_model: "eleven_text_to_sound_v2",
        source_asset: source.value.assetId,
        source_description: "horse neighing",
        source_duration: 6.048,
        target_duration: 15,
        continuation_duration: 8.952,
        generation_duration: 9.452,
        generation_attempts: 1,
        generation_loop_filled: false,
        crossfade_duration: 0.5,
      });
    }
  }, 30_000);

  it("leads the sound generation prompt with a continuation direction like add outro music", async () => {
    const source = await fs.createAsset("aud", "source", PROJECT_SLUG);
    const output = await fs.createAsset("aud", "extended", PROJECT_SLUG);
    if (!source.ok) throw new Error(source.error.message);
    if (!output.ok) throw new Error(output.error.message);
    const sourceWrite = await fs.writeFile(source.value.assetId, "original.mp3", sourceAudio, PROJECT_SLUG);
    if (!sourceWrite.ok) throw new Error(sourceWrite.error.message);

    const port = await listen(server);
    const provider = createElevenLabs({
      apiKey: "test-elevenlabs-key",
      baseURL: `http://127.0.0.1:${port}`,
      timeout: 30_000,
    });
    const payload: ExtendAudioPayload = {
      type: "extend_audio",
      audAssetId: output.value.assetId,
      sourceAssetId: source.value.assetId,
      sourceFilename: "original.mp3",
      sourceDurationMs: 6_048,
      targetDurationMs: 15_000,
      continuationPrompt: "add outro music",
      projectSlug: PROJECT_SLUG,
    };

    const result = await extendAudioWithElevenLabs(fs, payload, provider);

    expect(result.duration).toBeCloseTo(15, 1);
    const soundBody = JSON.parse(soundRequest?.body.toString("utf8") ?? "{}") as { text?: string };
    expect(soundBody.text?.startsWith("Continue this audio for 9.5s: add outro music.")).toBe(true);
    expect(soundBody.text).toContain("Source audio: horse neighing.");
    expect(soundBody.text).not.toContain("unrelated sound");
    expect(soundBody.text?.length).toBeLessThanOrEqual(450);

    const metadata = await fs.readMetadata(output.value.assetId, "original", PROJECT_SLUG);
    expect(metadata.ok).toBe(true);
    if (metadata.ok) {
      expect(metadata.value).toMatchObject({ continuation_prompt: "add outro music" });
    }
  }, 30_000);

  it("rejects a generated continuation with a silent tail", async () => {
    const silentTailPath = join(tempDir, "silent-tail.mp3");
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi",
      "-i", "sine=frequency=880:duration=3:sample_rate=44100",
      "-f", "lavfi",
      "-i", "anullsrc=channel_layout=mono:sample_rate=44100",
      "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1,atrim=duration=9.452[out]",
      "-map", "[out]",
      "-c:a", "libmp3lame",
      "-b:a", "128k",
      silentTailPath,
    ]);

    expect(await hasAudibleContinuationTail(silentTailPath)).toBe(false);
    expect(await hasAudibleContinuationTail(join(tempDir, "continuation.mp3"))).toBe(true);

    const silentTail = await readFile(silentTailPath);
    const filled = await fillLoopableContinuation(
      silentTail.buffer.slice(silentTail.byteOffset, silentTail.byteOffset + silentTail.byteLength),
      9.452,
    );
    const filledPath = join(tempDir, "filled.mp3");
    await writeFile(filledPath, new Uint8Array(filled));
    expect(await hasAudibleContinuationTail(filledPath)).toBe(true);
    const filledProbe = await probeVideo(filledPath);
    expect(filledProbe.audioDuration).toBeCloseTo(9.452, 1);
  }, 30_000);
});

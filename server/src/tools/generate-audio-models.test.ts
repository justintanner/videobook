import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import {
  ElevenLabsTextToSpeechTurbo25RequestSchema,
  GoogleGemini38FlashTtsRequestSchema,
  SunoGenerateRequestSchema,
  SunoSoundsRequestSchema,
} from "@apicity/kie/zod";
import {
  FalElevenlabsMusicV2p5RequestSchema,
  FalMinimaxMusic3RequestSchema,
} from "@apicity/fal/zod";
import { createTestClient } from "../test-client.js";
import { createEngineForTest } from "../engine.js";
import { pauseBookQueueForTests } from "../queue.js";
import { translateToolPayload } from "../payload-builders.js";
import { assessToolCallEstimate } from "../jobs/cost-estimate-assessment.js";
import { audioGenerationModels, SUNO_CALLBACK_URL } from "../audio-generation-models.js";
import { runAudioGeneration, type AudioGenerationJobPayload } from "../jobs/generate-audio-models.js";
import { GENERATION_ACTIONS } from "../generation-registry.js";
import type { listNotebookActions } from "../notebook-action-catalog.js";
import { runFfmpeg } from "../ffmpeg.js";

type RecordedRequest = { method: string; path: string; contentType: string; body: Buffer };

const ENV_KEYS = ["ELEVENLABS_API_KEY", "KIE_API_KEY", "FAL_API_KEY", "APICITY_PAYGATE_SECRET"] as const;

function resultJson(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  const content = result.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content[0]!.text!) as unknown;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function sendAudio(response: ServerResponse, bytes: Buffer, contentType: string): void {
  response.writeHead(200, { "content-type": contentType });
  response.end(bytes);
}

describe("audio generation models", () => {
  let fixtures: string;
  let mp3: Buffer;
  let wav: Buffer;
  let mp4: Buffer;
  let server: Server;
  let baseURL: string;
  let requests: RecordedRequest[];
  let root: string;
  let engine: Engine;
  let client: Client;
  const originalEnv = new Map<string, string | undefined>();

  function route(request: IncomingMessage, body: Buffer, response: ServerResponse): void {
    const path = request.url ?? "";
    if (path === "/v1/sound-generation" || path === "/v1/music" || path === "/v1/music/video-to-music") {
      sendAudio(response, mp3, "audio/mpeg");
      return;
    }
    if (path === "/api/v1/jobs/createTask") {
      sendJson(response, { code: 200, msg: "success", data: { taskId: "kie-task-1" } });
      return;
    }
    if (path.startsWith("/api/v1/jobs/recordInfo")) {
      sendJson(response, {
        code: 200,
        msg: "success",
        data: { taskId: "kie-task-1", state: "success", resultJson: JSON.stringify({ resultUrls: [`${baseURL}/files/speech.wav`] }) },
      });
      return;
    }
    if (path === "/api/v1/generate" || path === "/api/v1/generate/sounds") {
      sendJson(response, { code: 200, msg: "success", data: { taskId: "suno-task-1" } });
      return;
    }
    if (path.startsWith("/api/v1/generate/record-info")) {
      sendJson(response, {
        code: 200,
        msg: "success",
        data: {
          taskId: "suno-task-1",
          status: "SUCCESS",
          response: { taskId: "suno-task-1", sunoData: [{ id: "track-1", audioUrl: `${baseURL}/files/track.mp3`, duration: 1 }] },
        },
      });
      return;
    }
    if (path === "/elevenlabs/music/v2.5") {
      sendJson(response, { request_id: "fal-request-1", status: "IN_QUEUE" });
      return;
    }
    if (path === "/elevenlabs/music/requests/fal-request-1/status") {
      sendJson(response, { status: "COMPLETED" });
      return;
    }
    if (path === "/elevenlabs/music/requests/fal-request-1") {
      sendJson(response, { audio: { url: `${baseURL}/files/music.mp3` } });
      return;
    }
    if (path === "/files/speech.wav") {
      sendAudio(response, wav, "audio/wav");
      return;
    }
    if (path === "/files/track.mp3" || path === "/files/music.mp3") {
      sendAudio(response, mp3, "audio/mpeg");
      return;
    }
    void body;
    response.writeHead(404).end();
  }

  beforeAll(async () => {
    fixtures = await mkdtemp(join(tmpdir(), "videobook-audio-fixtures-"));
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libmp3lame", join(fixtures, "tone.mp3")]);
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=2", join(fixtures, "tone.wav")]);
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=1", "-pix_fmt", "yuv420p", join(fixtures, "clip.mp4")]);
    mp3 = await readFile(join(fixtures, "tone.mp3"));
    wav = await readFile(join(fixtures, "tone.wav"));
    mp4 = await readFile(join(fixtures, "clip.mp4"));
    server = createServer((request, response) => {
      void readBody(request).then((body) => {
        requests.push({
          method: request.method ?? "",
          path: request.url ?? "",
          contentType: request.headers["content-type"] ?? "",
          body,
        });
        route(request, body, response);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(fixtures, { recursive: true, force: true });
  });

  beforeEach(async () => {
    requests = [];
    root = await mkdtemp(join(tmpdir(), "videobook-audio-models-"));
    engine = createEngineForTest(root);
    client = await createTestClient(root);
    await pauseBookQueueForTests(engine.book.get().bookId);
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      process.env[key] = `test-${key.toLowerCase()}`;
    }
  });

  afterEach(async () => {
    await client.close();
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  function audioArtifacts() {
    return engine.artifacts.list().filter((artifact) => artifact.kind === "audio");
  }

  async function createAudioArtifact(): Promise<string> {
    const created = await engine.artifacts.create("aud", "generated audio");
    if (!created.ok) throw new Error(created.error.message);
    return created.value.artifactId;
  }

  async function runJob(toolName: string, args: Record<string, unknown>) {
    const audAssetId = await createAudioArtifact();
    const job: AudioGenerationJobPayload = {
      type: toolName,
      toolName,
      bookId: engine.book.get().bookId,
      audAssetId,
      args,
    };
    for (const key of ENV_KEYS) process.env[key] = `local-audio-${key.toLowerCase()}`;
    const result = await runAudioGeneration(engine, job, new AbortController().signal, {
      elevenlabsBaseURL: baseURL,
      kieBaseURL: baseURL,
      falQueueBaseURL: baseURL,
      pollIntervalMs: 5,
    }).finally(() => {
      for (const key of ENV_KEYS) process.env[key] = `test-${key.toLowerCase()}`;
    });
    const manifest = await engine.files.manifest(audAssetId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    const metadata = await engine.metadata.artifacts.read<Record<string, unknown>>(audAssetId, "original");
    if (!metadata.ok) throw new Error(metadata.error.message);
    return { audAssetId, result, files: manifest.value.files.map((file) => file.name), metadata: metadata.value };
  }

  it("registers every audio model as a visible generate_audio notebook action", async () => {
    const models = audioGenerationModels();
    expect(models).toHaveLength(21);
    for (const model of models) {
      const spec = GENERATION_ACTIONS.find((action) => action.canonical_name === model.canonicalName);
      expect(spec).toMatchObject({ media_type: "audio", picker_visibility: "visible", provider: model.provider });
    }
    const { actions } = resultJson(await client.callTool({
      name: "list_notebook_actions",
      arguments: { book_id: engine.book.get().bookId, cell_type: "generate_audio" },
    })) as { actions: ReturnType<typeof listNotebookActions> };
    const tools = new Set(actions.map((action) => action.tool));
    for (const model of models) expect(tools.has(model.canonicalName)).toBe(true);
    const music = actions.find((action) => action.tool === "generate_elevenlabs_music");
    expect(music?.controls).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "generation_mode", options: ["track", "loop", "ambience"], defaultValue: "track" }),
      expect.objectContaining({ name: "force_instrumental", defaultValue: true }),
    ]));
    const sounds = actions.find((action) => action.tool === "generate_kie_suno_sounds");
    expect(sounds?.controls).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "sound_key", kind: "select" }),
      expect.objectContaining({ name: "sound_tempo", kind: "number", minimum: 1, maximum: 300 }),
    ]));
    const videoToMusic = actions.find((action) => action.tool === "generate_elevenlabs_video_to_music");
    expect(videoToMusic?.inputContract?.modes[0]?.slots).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "video_ref", min: 1, max: 1 }),
    ]));
  });

  it("queues an audio artifact for each tool and rejects invalid requests first", async () => {
    const bookId = engine.book.get().bookId;
    const video = await engine.artifacts.create("video", "Clip");
    if (!video.ok) throw new Error(video.error.message);
    expect((await engine.files.write(video.value.artifactId, "original.mp4", mp4)).ok).toBe(true);
    const invalid: Array<[string, Record<string, unknown>]> = [
      ["generate_elevenlabs_sound_effect", { prompt: "door slam", duration_seconds: 31 }],
      ["generate_elevenlabs_sound_effect", { prompt: "" }],
      ["generate_kie_suno_sounds", { prompt: "rain", sound_tempo: 301 }],
      ["generate_fal_qwen_audio_3_tts", { prompt: "hello", voice: "Nobody" }],
      ["generate_elevenlabs_video_to_music", { video_ref: "@missing" }],
    ];
    for (const [name, args] of invalid) {
      const result = await client.callTool({ name, arguments: { book_id: bookId, ...args } });
      expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    }
    expect(audioArtifacts()).toEqual([]);
    for (const model of audioGenerationModels()) {
      const args = {
        book_id: bookId,
        prompt: "Soft rain on a tin roof",
        ...(model.route === "elevenlabs_video_to_music" ? { video_ref: `@${video.value.artifactId}` } : {}),
      };
      const response = resultJson(await client.callTool({ name: model.canonicalName, arguments: args })) as Record<string, unknown>;
      expect(response).toMatchObject({ status: "enqueued" });
      const jobs = engine.jobs.queue.list({ type: model.canonicalName });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.payload).toMatchObject({ toolName: model.canonicalName, audAssetId: response.aud_asset_id });
    }
    expect(audioArtifacts()).toHaveLength(21);
  });

  it("builds published provider requests from tool arguments", () => {
    const turbo = translateToolPayload("generate_kie_elevenlabs_text_to_speech_turbo_2_5", { prompt: "Welcome back" });
    expect(turbo?.provider_path).toBe("kie.post.api.v1.jobs.createTask(request, { otp })");
    expect(ElevenLabsTextToSpeechTurbo25RequestSchema.parse(turbo?.payload).input).toMatchObject({ text: "Welcome back", voice: "Rachel" });
    const gemini = GoogleGemini38FlashTtsRequestSchema.parse(
      translateToolPayload("generate_kie_gemini_3_8_flash_tts", { prompt: "Hi", voice: "Kore", style: "warm" })?.payload,
    );
    expect(gemini.input.speakers).toEqual([{ speaker_id: "Speaker 1", voice_name: "Kore" }]);
    expect(gemini.input.dialogue_turns).toEqual([{ speaker_id: "Speaker 1", text: "Hi", style: "warm" }]);
    const suno = SunoGenerateRequestSchema.parse(
      translateToolPayload("generate_kie_suno_music", { prompt: "Lo-fi beat", style: "lofi hip hop" })?.payload,
    );
    expect(suno).toMatchObject({ customMode: true, instrumental: true, style: "lofi hip hop", title: "Lo-fi beat", callBackUrl: SUNO_CALLBACK_URL });
    const sounds = SunoSoundsRequestSchema.parse(
      translateToolPayload("generate_kie_suno_sounds", { prompt: "Crackling fire", sound_loop: true, sound_tempo: "90" })?.payload,
    );
    expect(sounds).toEqual({ prompt: "Crackling fire", model: "V5_5", soundLoop: true, soundTempo: 90 });
    expect(FalMinimaxMusic3RequestSchema.parse(
      translateToolPayload("generate_fal_minimax_music_3", { prompt: "Cinematic strings", duration: 30 })?.payload,
    )).toMatchObject({ lyrics: "[Instrumental]", duration: 30 });
    expect(FalElevenlabsMusicV2p5RequestSchema.parse(
      translateToolPayload("generate_fal_elevenlabs_music_2_5", { prompt: "Calm ambience", music_length_ms: 90_000 })?.payload,
    )).toMatchObject({ music_length_ms: 90_000, output_format: "mp3_48000_192" });
  });

  it("prices the audio tools the pricing table covers and leaves the rest unpriced", async () => {
    const text = "x".repeat(1000);
    const priced: Array<[string, Record<string, unknown>, number]> = [
      ["generate_kie_elevenlabs_text_to_speech_turbo_2_5", { prompt: text }, 0.03],
      ["generate_kie_elevenlabs_text_to_speech_multilingual_v2", { prompt: text }, 0.06],
      ["generate_kie_elevenlabs_text_to_dialogue_v3", { prompt: text }, 0.07],
      ["generate_kie_suno_music", { prompt: "beat" }, 0.06],
      ["generate_kie_suno_sounds", { prompt: "rain" }, 0.0125],
      ["generate_fal_elevenlabs_music_2_5", { prompt: "beat", music_length_ms: 90_000 }, 1.2],
      ["generate_fal_elevenlabs_tts_eleven_v4", { prompt: text }, 0.08],
      ["generate_fal_qwen_audio_3_tts", { prompt: text }, 0.05],
    ];
    for (const [tool, args, usd] of priced) {
      const quote = await assessToolCallEstimate(engine, tool, args);
      expect(quote.available, tool).toBe(true);
      expect(quote.usd, tool).toBeCloseTo(usd);
    }
    for (const tool of ["generate_elevenlabs_sound_effect", "generate_kie_elevenlabs_sound_effect_v2", "generate_fal_minimax_music_3"]) {
      expect((await assessToolCallEstimate(engine, tool, { prompt: "rain" })).available, tool).toBe(false);
    }
  });

  it("writes ElevenLabs sound effects straight into the audio artifact", async () => {
    const run = await runJob("generate_elevenlabs_sound_effect", { prompt: "Glass shattering", duration_seconds: 2, loop: false });
    expect(run.files).toContain("original.mp3");
    expect(run.metadata).toMatchObject({ model: "elevenlabs/sound-generation", provider: "elevenlabs", prompt: "Glass shattering" });
    expect(run.result.duration).toBeGreaterThan(0.5);
    const request = requests.find((entry) => entry.path === "/v1/sound-generation")!;
    expect(JSON.parse(request.body.toString())).toEqual({ text: "Glass shattering", duration_seconds: 2, loop: false });
  });

  it("uploads the connected video for ElevenLabs video-to-music", async () => {
    const video = await engine.artifacts.create("video", "Clip");
    if (!video.ok) throw new Error(video.error.message);
    expect((await engine.files.write(video.value.artifactId, "original.mp4", mp4)).ok).toBe(true);
    const run = await runJob("generate_elevenlabs_video_to_music", { video_ref: `@${video.value.artifactId}`, prompt: "Upbeat synth" });
    expect(run.metadata).toMatchObject({ source_videos: [video.value.artifactId] });
    const request = requests.find((entry) => entry.path === "/v1/music/video-to-music")!;
    expect(request.contentType).toContain("multipart/form-data");
    expect(request.body.includes(Buffer.from("Upbeat synth"))).toBe(true);
  });

  it("polls Kie market tasks and transcodes non-MP3 results", async () => {
    const run = await runJob("generate_kie_elevenlabs_text_to_speech_turbo_2_5", { prompt: "Hello there" });
    expect(run.files).toContain("original.mp3");
    expect(run.metadata).toMatchObject({ task_id: "kie-task-1", download_url: `${baseURL}/files/speech.wav` });
    expect(run.result.duration).toBeGreaterThan(1.5);
    const submitted = JSON.parse(requests.find((entry) => entry.path === "/api/v1/jobs/createTask")!.body.toString());
    expect(submitted).toMatchObject({ model: "elevenlabs/text-to-speech-turbo-2-5", input: { text: "Hello there", voice: "Rachel" } });
  });

  it("polls Suno music and sounds tasks for the first finished track", async () => {
    const music = await runJob("generate_kie_suno_music", { prompt: "Chill background loop" });
    expect(music.metadata).toMatchObject({ task_id: "suno-task-1", model: "suno/generate" });
    const sounds = await runJob("generate_kie_suno_sounds", { prompt: "Thunder rolling", sound_loop: true });
    expect(sounds.files).toContain("original.mp3");
    const submittedSounds = JSON.parse(requests.find((entry) => entry.path === "/api/v1/generate/sounds")!.body.toString());
    expect(submittedSounds).toEqual({ prompt: "Thunder rolling", model: "V5_5", soundLoop: true });
  });

  it("submits fal queue requests and downloads the finished audio", async () => {
    const run = await runJob("generate_fal_elevenlabs_music_2_5", { prompt: "Warm ambient pad", music_length_ms: 10_000 });
    expect(run.metadata).toMatchObject({ task_id: "fal-request-1", provider: "fal", model: "elevenlabs/music/v2.5" });
    const submitted = JSON.parse(requests.find((entry) => entry.path === "/elevenlabs/music/v2.5")!.body.toString());
    expect(submitted).toMatchObject({ prompt: "Warm ambient pad", music_length_ms: 10_000, force_instrumental: false });
  });
});

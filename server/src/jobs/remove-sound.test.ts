import { closeEngineForTest, createEngineForTest } from "../fs.js";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createElevenLabs, type ElevenLabsSpeechToTextResponse } from "@apicity/elevenlabs";
import { type Engine } from "videobook-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractWaveform, FFMPEG, probeVideo } from "../ffmpeg.js";
import {
  buildSoundRemovalFilter,
  extractAudioEvents,
  matchSoundEvents,
  mergeSoundSegments,
  removeSoundWithElevenLabs,
  type RemoveSoundPayload,
  type SoundEvent,
} from "./remove-sound.js";

const execFileAsync = promisify(execFile);

const HORSE_EVENT: SoundEvent = { text: "horse neighing", start: 1.5, end: 2.5 };
const DOG_EVENT: SoundEvent = { text: "dog barking", start: 4, end: 4.5 };

function scribeResponse() {
  return {
    language_code: "eng",
    language_probability: 0.99,
    text: "[horse neighing] [dog barking]",
    words: [
      {
        text: "[horse neighing]",
        start: HORSE_EVENT.start,
        end: HORSE_EVENT.end,
        type: "audio_event",
        speaker_id: null,
      },
      {
        text: "[dog barking]",
        start: DOG_EVENT.start,
        end: DOG_EVENT.end,
        type: "audio_event",
        speaker_id: null,
      },
    ],
    channel_index: 0,
    transcription_id: "transcript-remove-123",
    audio_duration_secs: 6,
  };
}

describe("sound event matching", () => {
  it("extracts audio events from a transcript, stripping brackets", () => {
    const events = extractAudioEvents(scribeResponse() as unknown as ElevenLabsSpeechToTextResponse);
    expect(events).toEqual([HORSE_EVENT, DOG_EVENT]);
  });

  it("matches a plain description and ignores filler words", () => {
    const events = [HORSE_EVENT, DOG_EVENT];
    expect(matchSoundEvents(events, "horse")).toEqual([HORSE_EVENT]);
    expect(matchSoundEvents(events, "the horse sound")).toEqual([HORSE_EVENT]);
    expect(matchSoundEvents(events, "horses neigh")).toEqual([HORSE_EVENT]);
    expect(matchSoundEvents(events, "dog barks")).toEqual([DOG_EVENT]);
    expect(matchSoundEvents(events, "car engine")).toEqual([]);
  });

  it("rejects a description made only of filler words", () => {
    expect(() => matchSoundEvents([HORSE_EVENT], "the sound")).toThrow(/more specifically/);
  });

  it("pads, clamps, and merges overlapping segments", () => {
    const merged = mergeSoundSegments(
      [
        { text: "a", start: 0.05, end: 1 },
        { text: "b", start: 1.2, end: 2 },
        { text: "c", start: 4, end: 5.95 },
      ],
      6,
    );
    expect(merged).toEqual([
      { start: 0, end: 2.15 },
      { start: 3.85, end: 6 },
    ]);
  });

  it("builds a gated volume filter covering each segment", () => {
    const filter = buildSoundRemovalFilter([{ start: 1.35, end: 2.65 }]);
    expect(filter).toContain("volume=volume='(1-clip((t-1.3)/0.05,0,1)*clip((2.7-t)/0.05,0,1))':eval=frame[outa]");
    expect(filter).toContain("aresample=48000");
    expect(() => buildSoundRemovalFilter([])).toThrow(/No segments/);
  });
});

describe("remove sound ElevenLabs job", () => {
  let tempDir: string;
  let engineRoot: string;
  let fs: Engine;
  let bookId: string;
  let server: Server;

  async function listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (typeof address === "object" && address !== null) resolve(address.port);
        else reject(new Error("Local ElevenLabs server has no TCP address"));
      });
    });
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-remove-sound-test-"));
    server = createServer((request, response) => {
      request.on("data", () => {});
      request.on("end", () => {
        if (request.url === "/v1/speech-to-text") {
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify(scribeResponse()));
          return;
        }
        response.statusCode = 404;
        response.end();
      });
    });
    engineRoot = join(tempDir, "projects");
    fs = createEngineForTest(engineRoot);
    bookId = fs.book.get().bookId;
  });

  afterEach(async () => {
    closeEngineForTest(engineRoot, fs);
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function makeProvider() {
    const port = await listen();
    return createElevenLabs({
      apiKey: "test-elevenlabs-key",
      baseURL: `http://127.0.0.1:${port}`,
      timeout: 30_000,
    });
  }

  function quietAndLoudBars(peaks: number[], duration: number) {
    const bar = duration / peaks.length;
    const inWindow = (index: number, start: number, end: number) => {
      const center = index * bar + bar / 2;
      return center > start && center < end;
    };
    return {
      horse: peaks.filter((_, index) => inWindow(index, 1.6, 2.4)),
      dog: peaks.filter((_, index) => inWindow(index, 4.05, 4.45)),
      intro: peaks.filter((_, index) => inWindow(index, 0.2, 1.2)),
    };
  }

  it("silences only the matched window of an aud-* asset and refreshes its waveform", async () => {
    const sourcePath = join(tempDir, "source.mp3");
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi",
      "-i", "sine=frequency=440:duration=6:sample_rate=48000",
      "-c:a", "libmp3lame",
      "-b:a", "192k",
      sourcePath,
    ]);
    const created = await fs.artifacts.create("aud", "haunted");
    if (!created.ok) throw new Error(created.error.message);
    const write = await fs.files.write(created.value.slug, "original.mp3", await readFile(sourcePath));
    if (!write.ok) throw new Error(write.error.message);
    const assetDir = await fs.workspaces.resolveArtifact(created.value.slug);
    if (!assetDir.ok) throw new Error(assetDir.error.message);

    const payload: RemoveSoundPayload = {
      type: "remove_sound",
      assetId: created.value.slug,
      assetKind: "audio",
      assetDir: assetDir.value,
      filename: "original.mp3",
      sound: "horse sound",
      bookId,
    };
    const result = await removeSoundWithElevenLabs(fs, payload, await makeProvider());

    expect(result.matched_events).toEqual([HORSE_EVENT]);
    expect(result.removed_segments).toEqual([{ start: 1.35, end: 2.65 }]);
    expect(result.removed_seconds).toBeCloseTo(1.3, 5);
    expect(result.detected_events).toEqual([
      "[horse neighing] 1.50-2.50s",
      "[dog barking] 4.00-4.50s",
    ]);

    const outputPath = join(assetDir.value, "original.mp3");
    const probe = await probeVideo(outputPath);
    expect(probe.audioDuration ?? probe.duration).toBeCloseTo(6, 0);
    const peaks = await extractWaveform(outputPath, 60);
    const bars = quietAndLoudBars(peaks, 6);
    expect(Math.max(...bars.horse)).toBeLessThan(0.01);
    expect(Math.min(...bars.dog)).toBeGreaterThan(0.1);
    expect(Math.min(...bars.intro)).toBeGreaterThan(0.1);

    const waveform = await fs.metadata.waveforms.read(created.value.slug);
    expect(waveform.ok).toBe(true);
    if (waveform.ok) expect(waveform.value.peaks.length).toBeGreaterThan(0);
  }, 30_000);

  it("silences the matched window of a vid-* asset without touching the video stream", async () => {
    const sourcePath = join(tempDir, "source.mp4");
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "testsrc=duration=6:size=320x240:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=6:sample_rate=48000",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      sourcePath,
    ]);
    const created = await fs.artifacts.create("vid", "haunted");
    if (!created.ok) throw new Error(created.error.message);
    const write = await fs.files.write(created.value.slug, "original.mp4", await readFile(sourcePath));
    if (!write.ok) throw new Error(write.error.message);
    const assetDir = await fs.workspaces.resolveArtifact(created.value.slug);
    if (!assetDir.ok) throw new Error(assetDir.error.message);

    const payload: RemoveSoundPayload = {
      type: "remove_sound",
      assetId: created.value.slug,
      assetKind: "video",
      assetDir: assetDir.value,
      filename: "original.mp4",
      sound: "horse neighing",
      bookId,
    };
    const result = await removeSoundWithElevenLabs(fs, payload, await makeProvider());
    expect(result.removed_segments).toEqual([{ start: 1.35, end: 2.65 }]);

    const outputPath = join(assetDir.value, "original.mp4");
    const probe = await probeVideo(outputPath);
    expect(probe.videoCodec).toBe("h264");
    expect(probe.videoDuration).toBeCloseTo(6, 0);
    expect(probe.hasAudio).toBe(true);
    const peaks = await extractWaveform(outputPath, 60);
    const bars = quietAndLoudBars(peaks, 6);
    expect(Math.max(...bars.horse)).toBeLessThan(0.01);
    expect(Math.min(...bars.dog)).toBeGreaterThan(0.1);
  }, 30_000);

  it("reports detected events when the description matches nothing", async () => {
    const sourcePath = join(tempDir, "source.mp3");
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi",
      "-i", "sine=frequency=440:duration=6:sample_rate=48000",
      "-c:a", "libmp3lame",
      sourcePath,
    ]);
    const created = await fs.artifacts.create("aud", "haunted");
    if (!created.ok) throw new Error(created.error.message);
    const write = await fs.files.write(created.value.slug, "original.mp3", await readFile(sourcePath));
    if (!write.ok) throw new Error(write.error.message);
    const assetDir = await fs.workspaces.resolveArtifact(created.value.slug);
    if (!assetDir.ok) throw new Error(assetDir.error.message);

    const payload: RemoveSoundPayload = {
      type: "remove_sound",
      assetId: created.value.slug,
      assetKind: "audio",
      assetDir: assetDir.value,
      filename: "original.mp3",
      sound: "car engine",
      bookId,
    };
    await expect(removeSoundWithElevenLabs(fs, payload, await makeProvider()))
      .rejects.toThrow(/No audio event matching "car engine".*horse neighing.*dog barking/);
  }, 30_000);
});

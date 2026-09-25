import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createEngineForTest } from "../engine.js";
import { FFMPEG } from "../ffmpeg.js";
import { queue } from "../queue.js";
import { createTestClient } from "../test-client.js";
import { resolveAliveCues } from "../remotion/subtitles/alive-layout.js";
import type { AliveAnalysis, AliveSettings } from "../remotion/subtitles/alive-types.js";
import { DEFAULT_ALIVE_SETTINGS } from "../remotion/subtitles/alive-types.js";
import { aliveRenderTrack } from "../alive-captions/track.js";

const execFileAsync = promisify(execFile);

type TextContent = Array<{ type: string; text: string }>;

const BURSTS = "sin(2*PI*440*t)*(0.8*between(t,0.5,0.8)+0.8*between(t,1.0,1.7)+0.2*between(t,2.5,2.8))";

/** "burning" is transcribed 50 ms after its vocal onset at 1.0 s. */
const TRANSCRIPT = {
  language_code: "eng",
  words: [
    { text: "We", start: 0.5, end: 0.7, type: "word" },
    { text: " ", start: 0.7, end: 0.7, type: "spacing" },
    { text: "were", start: 0.7, end: 0.95, type: "word" },
    { text: "burning.", start: 1.05, end: 1.7, type: "word" },
    { text: "quiet", start: 2.5, end: 2.8, type: "word" },
  ],
};

function parse(result: { content: unknown }): Record<string, unknown> {
  return JSON.parse((result.content as TextContent)[0].text) as Record<string, unknown>;
}

describe("alive caption tools", () => {
  let client: Client;
  let engine: Engine;
  let tempDir: string;
  let videoBytes: Buffer;
  const bookId = "alive-proj";

  beforeAll(async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    await queue.start();
    tempDir = await mkdtemp(join(tmpdir(), "videobook-alive-tool-"));
    const sourcePath = join(tempDir, "source.mp4");
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "color=c=gray:s=320x180:r=24:d=3.2",
      "-f", "lavfi", "-i", `aevalsrc='${BURSTS}':s=44100:d=3.2`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest",
      sourcePath,
    ]);
    videoBytes = await readFile(sourcePath);
    client = await createTestClient(tempDir);
    engine = createEngineForTest(tempDir);
    await client.callTool({ name: "create_project", arguments: { book_id: bookId } });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await client?.close();
    await queue.stop();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function createVideo(withTranscript: boolean): Promise<string> {
    const created = await engine.artifacts.create("vid", "night drive");
    if (!created.ok) throw new Error(created.error.message);
    const assetId = created.value.artifactId;
    const video = await engine.files.write(assetId, "original.mp4", videoBytes);
    if (!video.ok) throw new Error(video.error.message);
    if (withTranscript) {
      const written = await engine.files.write(assetId, "elevenlabs.json", JSON.stringify(TRANSCRIPT));
      if (!written.ok) throw new Error(written.error.message);
    }
    return assetId;
  }

  it("reports a missing transcript and a missing artifact as structured errors", async () => {
    const bare = await createVideo(false);
    const missingTranscript = await client.callTool({ name: "alive_captions", arguments: { book_id: bookId, asset_id: bare } });
    expect(missingTranscript.isError).toBe(true);
    expect(parse(missingTranscript).status).toBe("missing_transcript");

    const missing = await client.callTool({ name: "alive_captions", arguments: { book_id: bookId, asset_id: "vid-missing" } });
    expect(missing.isError).toBe(true);
    expect(parse(missing).status).toBe("asset_not_found");
  });

  it("analyses phrases, vocal onsets and energy, then serves the cache", async () => {
    const assetId = await createVideo(true);
    const first = await client.callTool({ name: "alive_captions", arguments: { book_id: bookId, asset_id: assetId } });
    expect(first.isError).toBeFalsy();
    const response = parse(first);
    expect(response).toMatchObject({ status: "ready", cached: false, regions_analyzed: false, settings: DEFAULT_ALIVE_SETTINGS });

    const analysis = response.analysis as AliveAnalysis;
    expect(analysis.sourceWidth).toBe(320);
    expect(analysis.durationSeconds).toBeCloseTo(3.2, 0);
    expect(analysis.envelope.length).toBeGreaterThan(50);
    expect(analysis.phrases.map((phrase) => phrase.lines.map((line) => line.map((word) => word.text)))).toEqual([
      [["We", "were"], ["burning"]],
      [["quiet"]],
    ]);
    const burning = analysis.phrases[0].lines[1][0];
    expect(burning.transcriptStart).toBe(1.05);
    expect(Math.abs(burning.onsetStart - 1.0)).toBeLessThanOrEqual(0.04);
    const quiet = analysis.phrases[1].lines[0][0];
    expect(quiet.energy).toBeLessThan(burning.energy);

    const second = await client.callTool({ name: "alive_captions", arguments: { book_id: bookId, asset_id: assetId } });
    expect(parse(second)).toMatchObject({ cached: true });
    expect((parse(second).analysis as AliveAnalysis).analyzedAt).toBe(analysis.analyzedAt);

    const cues = resolveAliveCues(analysis.phrases, DEFAULT_ALIVE_SETTINGS, {
      sourceWidth: 320, sourceHeight: 180, targetWidth: 1080, targetHeight: 1920,
    });
    expect(cues).toHaveLength(2);
    expect(cues[0].column.side).toBe("center");
    expect(cues[0].end).toBeLessThanOrEqual(cues[1].start);
  });

  it("saves settings, points renders at alive captions, and feeds the render track", async () => {
    const assetId = await createVideo(true);
    const saved = await client.callTool({
      name: "set_alive_captions",
      arguments: { book_id: bookId, asset_id: assetId, style: "punch", motion: "slam", hit_color: "#F0B9D0", snap_to_onsets: false },
    });
    expect(saved.isError).toBeFalsy();
    const expected: AliveSettings = { ...DEFAULT_ALIVE_SETTINGS, style: "punch", motion: "slam", hitColor: "#F0B9D0", snapToOnsets: false };
    expect(parse(saved)).toMatchObject({ status: "configured", settings: expected, applied_to_renders: true });

    for (const orientation of ["landscape", "portrait", "square"]) {
      const stored = await engine.metadata.artifacts.read<Record<string, unknown>>(assetId, `${orientation}.render`);
      expect(stored.ok && stored.value).toMatchObject({ subtitlesEnabled: true, highlightStyle: "alive" });
    }

    const track = await aliveRenderTrack(engine, assetId, {
      sourceWidth: 320, sourceHeight: 180, targetWidth: 1920, targetHeight: 1080,
    }, new AbortController().signal);
    expect(track.settings).toEqual(expected);
    const burning = track.cues[0].lines[1].words[0];
    expect(burning.start).toBe(1.05);

    const loaded = await client.callTool({ name: "alive_captions", arguments: { book_id: bookId, asset_id: assetId } });
    expect(parse(loaded).settings).toEqual(expected);
  });

  it("rejects invalid colors without changing stored settings", async () => {
    const assetId = await createVideo(true);
    const result = await client.callTool({
      name: "set_alive_captions",
      arguments: { book_id: bookId, asset_id: assetId, hit_color: "green" },
    });
    expect(result.isError).toBe(true);
    expect(parse(result).status).toBe("invalid_color");
    const stored = await engine.metadata.artifacts.read(assetId, "alive-captions.settings");
    expect(stored.ok).toBe(false);
  });
});

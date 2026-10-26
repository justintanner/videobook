import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Engine } from "videobook-engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fileObjectHash } from "../analysis-sidecars.js";
import { createEngineForTest } from "../engine.js";
import { FFMPEG } from "../ffmpeg.js";
import type { FrameRegion } from "../frame-regions.js";
import { storeFrameRegions } from "../frame-regions.js";
import { readKeywordPlacementAnalysis } from "../keyword-placement-cache.js";
import { queue, waitForBookJob, waitForBookQueuesIdleForTests } from "../queue.js";
import { createTestClient } from "../test-client.js";
import { testBudget } from "../test-budget.js";
import type { Client } from "@modelcontextprotocol/client";
import { analyzeOsgPlacement } from "./osg-placement.js";

const execFileAsync = promisify(execFile);

const TOP_RIGHT_FACE: FrameRegion = { kind: "face", confidence: 0.95, x: 0.7, y: 0.02, width: 0.28, height: 0.3 };
const LOWER_TITLE: FrameRegion = { kind: "text", confidence: 0.9, x: 0.05, y: 0.75, width: 0.9, height: 0.15 };

describe("overlay placement reuses frame regions found by earlier passes", () => {
  let client: Client;
  let engine: Engine;
  let bookId: string;
  let tempDir: string;
  let videoBytes: Buffer;

  async function write(artifactId: string, name: string, content: string | Buffer): Promise<void> {
    const written = await engine.files.write(artifactId, name, content);
    if (!written.ok) throw new Error(written.error.message);
  }

  async function video(label: string): Promise<{ artifactId: string; path: string; mediaHash: string }> {
    const created = await engine.artifacts.create("video", label);
    if (!created.ok) throw new Error(created.error.message);
    const artifactId = created.value.artifactId;
    await write(artifactId, "original.mp4", videoBytes);
    const manifest = await engine.files.manifest(artifactId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    return { artifactId, path: manifest.value.path, mediaHash: await fileObjectHash(engine, artifactId, "original.mp4") as string };
  }

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-frame-reuse-"));
    const output = join(tempDir, "clip.mp4");
    await execFileAsync(FFMPEG, [
      "-y", "-f", "lavfi", "-i", "color=c=teal:s=320x180:r=12:d=2",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", output,
    ]);
    videoBytes = await readFile(output);
    await queue.start();
    client = await createTestClient(tempDir);
    engine = createEngineForTest(tempDir);
    bookId = engine.book.get().bookId;
  });

  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "");
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(20_000) }).catch(() => undefined);
    await client?.close();
    await queue.stop();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("places the watermark from cached regions without a vision key", async () => {
    const { artifactId, mediaHash } = await video("watermark source");
    for (const time of ["0.000", "1.000"]) await write(artifactId, `original_frames/${time}.jpg`, Buffer.from(time));
    const meta = await engine.metadata.artifacts.write(artifactId, "original", { width: 320, height: 180, duration: 2 });
    if (!meta.ok) throw new Error(meta.error.message);
    storeFrameRegions(engine, artifactId, mediaHash, [{ time: 0, regions: [TOP_RIGHT_FACE] }, { time: 1, regions: [TOP_RIGHT_FACE] }]);

    const analysis = await analyzeOsgPlacement(engine, { assetId: artifactId, fingerprint: "fp", userScale: 1, signal: new AbortController().signal });
    expect(analysis.regions).toEqual([TOP_RIGHT_FACE, TOP_RIGHT_FACE]);
    expect(Object.values(analysis.positions)).not.toContain("top-right");
  });

  it("places keyword titles from cached regions without a vision key", async () => {
    const { artifactId, path, mediaHash } = await video("keyword source");
    storeFrameRegions(engine, artifactId, mediaHash, [{ time: 0.5, regions: [LOWER_TITLE] }, { time: 1.25, regions: [TOP_RIGHT_FACE] }]);
    const job = await queue.enqueue(`keyword-placement-${artifactId}`, {
      type: "analyze_keyword_placement",
      assetId: artifactId,
      assetDir: path,
      bookId,
      videoPath: join(path, "original.mp4"),
      fingerprint: "keywords-v1",
      graphics: [
        { text: "Night", start: 0.4, end: 0.8, side: "left", frameTime: 0.5 },
        { text: "Drive", start: 1.1, end: 1.6, side: "right", frameTime: 1.25 },
      ],
    });
    await waitForBookJob(bookId, job.id, testBudget(30_000));
    const analysis = await readKeywordPlacementAnalysis(engine, artifactId);
    expect(analysis?.cues.map((cue) => [cue.text, cue.regions])).toEqual([["Night", [LOWER_TITLE]], ["Drive", [TOP_RIGHT_FACE]]]);
  }, testBudget(60_000));
});

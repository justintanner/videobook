import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { probeVideo } from "../ffmpeg.js";
import { assertSaneTrimOutput, trimRange, trimRangeExact } from "./trim-video.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");

describe("trimRange", () => {
  let dir: string;
  let sourcePath: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "trim-range-"));
    sourcePath = join(dir, "source.mp4");
    // 12s h264/aac with a keyframe every second so stream-copy mid-cuts stay sane.
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "testsrc=duration=12:size=320x240:rate=24",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-g", "24", "-keyint_min", "24",
      "-c:a", "aac", "-shortest",
      sourcePath,
    ]);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("splits mid-clip into sane chunks without leaving .tmp husks", async () => {
    const outA = join(dir, "a.mp4");
    const outB = join(dir, "b.mp4");
    const t0 = Date.now();
    await Promise.all([
      trimRange(sourcePath, outA, undefined, 5),
      trimRange(sourcePath, outB, 5, undefined),
    ]);
    const elapsedMs = Date.now() - t0;
    // Stream-copy is preferred; re-encode fallback is fine for synthetic
    // clips with no mid-GOP keyframes. Either way this 12s 320x240 source
    // must finish well under the 300s job timeout that long re-encodes hit.
    expect(elapsedMs).toBeLessThan(15_000);

    const [probeA, probeB] = await Promise.all([
      probeVideo(outA),
      probeVideo(outB),
    ]);
    expect(probeA.duration).toBeGreaterThan(4);
    expect(probeA.duration).toBeLessThan(6.5);
    expect(probeB.duration).toBeGreaterThan(6);
    expect(probeB.duration).toBeLessThan(8);

    await assertSaneTrimOutput(sourcePath, outA);
    await assertSaneTrimOutput(sourcePath, outB);

    // Both outputs must be real finalized files (not leftover .tmp husks).
    await expect(stat(outA)).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(stat(outB)).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(stat(`${outA}.tmp`)).rejects.toThrow();
    await expect(stat(`${outB}.tmp`)).rejects.toThrow();
  });

  it("keeps exact integer-second cuts on a 24fps keyed source via copy", async () => {
    const out = join(dir, "exact-7s.mp4");
    const started = Date.now();
    await trimRangeExact(sourcePath, out, 0, 7);
    // Preserve a regression guard without assuming dedicated-runner latency.
    expect(Date.now() - started).toBeLessThan(10_000);
    const probe = await probeVideo(out);
    expect(probe.duration).toBeGreaterThan(6.95);
    expect(probe.duration).toBeLessThanOrEqual(7.05);
    await assertSaneTrimOutput(sourcePath, out);
  });

  it("handles a closed range (start+end)", async () => {
    const out = join(dir, "mid.mp4");
    await trimRange(sourcePath, out, 2, 7);
    const probe = await probeVideo(out);
    expect(probe.duration).toBeGreaterThan(4);
    expect(probe.duration).toBeLessThan(6);
    await assertSaneTrimOutput(sourcePath, out);
  });

  it("falls back to re-encoding when a copy trim omits the video stream", async () => {
    const sparseGopSource = join(dir, "sparse-gop.mp4");
    const out = join(dir, "sparse-gop-tail.mp4");
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "testsrc=duration=6:size=320x240:rate=24",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-g", "9999", "-keyint_min", "9999", "-sc_threshold", "0",
      "-c:a", "aac", "-shortest",
      sparseGopSource,
    ]);

    await trimRange(sparseGopSource, out, 1, undefined);

    const probe = await probeVideo(out);
    expect(probe.videoCodec).toBe("h264");
    expect(probe.width).toBe(320);
    expect(probe.height).toBe(240);
    expect(probe.duration).toBeGreaterThan(4);
    expect(probe.duration).toBeLessThan(6);
    await assertSaneTrimOutput(sparseGopSource, out);
  });
});

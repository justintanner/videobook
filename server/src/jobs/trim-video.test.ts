import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { probeVideo } from "../ffmpeg.js";
import { assertSaneTrimOutput, trimRange } from "./trim-video.js";

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

  it("handles a closed range (start+end)", async () => {
    const out = join(dir, "mid.mp4");
    await trimRange(sourcePath, out, 2, 7);
    const probe = await probeVideo(out);
    expect(probe.duration).toBeGreaterThan(4);
    expect(probe.duration).toBeLessThan(6);
    await assertSaneTrimOutput(sourcePath, out);
  });
});

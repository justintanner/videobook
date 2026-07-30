import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runFfmpeg } from "../../server/src/ffmpeg.js";
import {
  deriveCameraCandidates,
  detectSceneSamples,
  refineCameraCandidate,
} from "../../server/src/scene-detect.js";

describe("camera candidate detection", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("finds and refines real hard cuts while clustering nearby score peaks", async () => {
    directory = await mkdtemp(join(tmpdir(), "videobook-scene-detect-"));
    const videoPath = join(directory, "cuts.mp4");
    await runFfmpeg([
      "-y",
      "-f", "lavfi", "-i", "color=c=red:s=64x64:d=1:r=12",
      "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=1:r=12",
      "-f", "lavfi", "-i", "color=c=green:s=64x64:d=1:r=12",
      "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
      "-map", "[v]",
      "-pix_fmt", "yuv420p",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      videoPath,
    ]);

    const samples = await detectSceneSamples(videoPath, { fps: 4 });
    const candidates = deriveCameraCandidates(samples);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.t).toBeCloseTo(1, 1);
    expect(candidates[1]?.t).toBeCloseTo(2, 1);

    const refined = await Promise.all(
      candidates.map((candidate) =>
        refineCameraCandidate(videoPath, candidate)),
    );
    expect(refined[0]?.t).toBeCloseTo(1, 1);
    expect(refined[1]?.t).toBeCloseTo(2, 1);
  });

  it("keeps the strongest local peak from a half-second transition cluster", () => {
    expect(deriveCameraCandidates([
      { t: 0, score: 0 },
      { t: 1, score: 8 },
      { t: 1.25, score: 14 },
      { t: 1.5, score: 7 },
      { t: 3, score: 11 },
      { t: 3.25, score: 2 },
    ])).toEqual([
      { t: 1.25, score: 14 },
      { t: 3, score: 11 },
    ]);
  });
});

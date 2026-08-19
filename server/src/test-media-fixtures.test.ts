import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { probeVideo } from "./ffmpeg.js";
import {
  COMMON_VIDEO_FIXTURES,
  copyVideoFixture,
  materializeVideoFixture,
  videoFixtureKey,
} from "./test-media-fixtures.js";

describe("cached FFmpeg video fixtures", () => {
  const scratch: string[] = [];

  afterEach(async () => {
    await Promise.all(scratch.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 3 })));
  });

  it("generates once per spec and copies immutable bytes for ingest", async () => {
    const spec = COMMON_VIDEO_FIXTURES.extractAudio;
    const first = await materializeVideoFixture(spec);
    const firstStat = await stat(first);
    const second = await materializeVideoFixture(spec);
    expect(second).toBe(first);
    expect((await stat(second)).mtimeMs).toBe(firstStat.mtimeMs);

    const destDir = await mkdtemp(join(tmpdir(), "vb-fixture-copy-"));
    scratch.push(destDir);
    const dest = join(destDir, "ingested.mp4");
    await copyVideoFixture(spec, dest);
    const [cachedBytes, copiedBytes] = await Promise.all([
      readFile(first),
      readFile(dest),
    ]);
    expect(copiedBytes.equals(cachedBytes)).toBe(true);
    expect(dest).not.toBe(first);

    const probe = await probeVideo(dest);
    expect(probe.width).toBe(spec.width);
    expect(probe.height).toBe(spec.height);
    expect(probe.hasAudio).toBe(true);
    expect(probe.duration).toBeGreaterThan(1.5);
    expect(probe.duration).toBeLessThan(2.5);
  });

  it("keeps dimension and silent-audio edge specs distinct", () => {
    expect(videoFixtureKey(COMMON_VIDEO_FIXTURES.cropHd))
      .not.toBe(videoFixtureKey(COMMON_VIDEO_FIXTURES.watermark));
    expect(videoFixtureKey(COMMON_VIDEO_FIXTURES.extractAudio))
      .not.toBe(videoFixtureKey(COMMON_VIDEO_FIXTURES.extractAudioSilent));
    expect(videoFixtureKey(COMMON_VIDEO_FIXTURES.timeline(24)))
      .not.toBe(videoFixtureKey(COMMON_VIDEO_FIXTURES.timeline(30)));
  });
});

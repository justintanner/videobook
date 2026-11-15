import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeVideo } from "../ffmpeg.js";
import { testBudget } from "../test-budget.js";
import { BUILTIN_SOUNDS } from "./catalog.js";
import { renderBuiltinSound } from "./synth.js";
import { encodeWav } from "./wav.js";

describe("built-in sound WAV encoding", () => {
  it.each(BUILTIN_SOUNDS)("encodes $id as stereo 48 kHz PCM with its catalog duration", async (sound) => {
    const dir = await mkdtemp(join(tmpdir(), "builtin-sound-"));
    try {
      const path = join(dir, "sound.wav");
      const bytes = encodeWav(renderBuiltinSound(sound.id));
      expect(bytes.length).toBe(44 + Math.round(sound.durationSeconds * 48_000) * 4);
      await writeFile(path, bytes);
      const probe = await probeVideo(path, { timeoutMs: testBudget(10_000) });
      const stream = probe.audioStream;
      expect(probe.audioCodec).toBe("pcm_s16le");
      expect(stream?.audio?.sampleRateHz).toBe(48_000);
      expect(stream?.audio?.channels).toBe(2);
      expect(Math.abs(probe.duration - sound.durationSeconds)).toBeLessThanOrEqual(0.001);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("interleaves signed samples and clips at the PCM limits", () => {
    const bytes = encodeWav({ sampleRate: 48_000, left: new Float32Array([-2, 0, 0.5]), right: new Float32Array([2, -0.5, 0]) });
    const view = new DataView(bytes.buffer);
    expect(Array.from({ length: 6 }, (_, index) => view.getInt16(44 + index * 2, true))).toEqual([-32_768, 32_767, 0, -16_384, 16_384, 0]);
  });

  it("rejects unequal channel lengths", () => {
    expect(() => encodeWav({ sampleRate: 48_000, left: new Float32Array(1), right: new Float32Array(2) })).toThrow("equal lengths");
  });
});

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { probeVideo } from "../ffmpeg.js";
import { testBudget } from "../test-budget.js";
import { BUILTIN_SOUND_IDS, builtinSound, isRecordedSound } from "./catalog.js";
import { builtinRecordingPath } from "./recordings.js";

describe("recorded built-in sounds", () => {
  it.each(BUILTIN_SOUND_IDS.filter(isRecordedSound))("ships %s as a stereo 48 kHz recording of its catalog length", async (id) => {
    const path = builtinRecordingPath(id);
    expect(existsSync(path)).toBe(true);
    const probe = await probeVideo(path, { timeoutMs: testBudget(10_000) });
    expect(probe.hasAudio).toBe(true);
    expect(probe.audioStream?.audio?.sampleRateHz).toBe(48_000);
    expect(probe.audioStream?.audio?.channels).toBe(2);
    expect(Math.abs(probe.duration - builtinSound(id).durationSeconds)).toBeLessThanOrEqual(0.05);
    expect(builtinSound(id).accentSeconds).toBeLessThan(builtinSound(id).durationSeconds);
  });
});

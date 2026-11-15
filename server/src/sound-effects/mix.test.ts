import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBuiltinSfxFilter, writeBuiltinSfxFiles } from "./mix.js";

const cues = [{ sound: "pop", startSeconds: 1.25, gain: 0.35 }, { sound: "ding", startSeconds: 2, gain: 0.7 }] as const;

describe("built-in sound mixing graph", () => {
  it("preserves and bounds the source sound, delays each cue and limits the sum", () => {
    const graph = buildBuiltinSfxFilter(cues, true, 3);
    expect(graph).toContain("[0:a:0]aresample=48000");
    expect(graph).toContain("apad,atrim=duration=3.000000");
    expect(graph).toContain("volume=0.35,adelay=60000S|60000S[s0]");
    expect(graph).toContain("volume=0.7,adelay=96000S|96000S[s1]");
    expect(graph).toContain("[base][s0][s1]amix=inputs=3:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=false[outa]");
  });

  it("creates a finite silent bed when the source has no audio", () => {
    const graph = buildBuiltinSfxFilter(cues.slice(0, 1), false, 3);
    expect(graph).toContain("anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=3.000000");
    expect(graph).not.toContain("[0:a:0]");
    expect(() => buildBuiltinSfxFilter(cues, false, 0)).toThrow("duration");
    expect(() => buildBuiltinSfxFilter([], true, 3)).toThrow("cue");
    expect(() => buildBuiltinSfxFilter([{ ...cues[0], gain: 2 }], true, 3)).toThrow("gain");
    expect(() => buildBuiltinSfxFilter([{ ...cues[0], startSeconds: -1 }], true, 3)).toThrow("start");
  });

  it("writes each distinct sound once and reuses its path for repeated cues", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builtin-cues-"));
    try {
      const paths = await writeBuiltinSfxFiles(dir, [cues[0], cues[0], cues[1]]);
      expect(paths[0]).toBe(paths[1]);
      expect(paths[2]).not.toBe(paths[0]);
      expect((await readdir(dir)).sort()).toEqual(["ding.wav", "pop.wav"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

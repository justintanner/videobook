import { describe, expect, it } from "vitest";
import { buildSegmentFilterGraph, buildSegmentRenderArgs, segmentPictureFilters } from "./graph.js";
import type { SegmentPlan } from "./plan.js";

function samplePlan(overrides: Partial<SegmentPlan> = {}): SegmentPlan {
  return {
    version: 1,
    source: {
      artifactId: "clip-1",
      sourceHash: "c".repeat(64),
      fps: 30,
      frames: 120,
      width: 320,
      height: 180,
      hasAudio: true,
    },
    segments: [
      { id: "hook", role: "cold_open", startFrame: 60, endFrame: 90, speed: 1, motion: "repeat", audio: "source" },
      { id: "body", role: "body", startFrame: 0, endFrame: 120, speed: 1, motion: "repeat", audio: "source" },
    ],
    ...overrides,
  };
}

describe("segment render graph builder", () => {
  it("refuses a plan with validation issues", () => {
    const bad = samplePlan({
      segments: [
        { id: "dup", role: "body", startFrame: 0, endFrame: 30, speed: 1, motion: "repeat", audio: "source" },
        { id: "dup", role: "body", startFrame: 0, endFrame: 30, speed: 1, motion: "repeat", audio: "source" },
      ],
    });
    expect(() => buildSegmentRenderArgs(bad, {
      inputPath: "/in.mp4",
      outputPath: "/out.mp4",
      variableFrameRate: false,
    })).toThrow('Duplicate segment id "dup"');
  });

  it("opens one seeked input per segment with no -ss at frame 0 and no split filters", () => {
    const args = buildSegmentRenderArgs(samplePlan(), {
      inputPath: "/in.mp4",
      outputPath: "/out.mp4",
      variableFrameRate: false,
    });
    const filterIdx = args.indexOf("-filter_complex");
    expect(filterIdx).toBeGreaterThan(0);
    const inputSlice = args.slice(0, filterIdx);
    expect(inputSlice).toEqual([
      "-y",
      "-ss", "1.983333", "-t", "1.033333", "-i", "/in.mp4",
      "-t", "4.033333", "-i", "/in.mp4",
    ]);
    const filter = args[filterIdx + 1]!;
    expect(filter).not.toContain("split");
    expect(filter).toContain("atrim=start=0.016666666667");
    expect(filter).toContain("[v0][a0][v1][a1]concat=n=2:v=1:a=1[vout][aout]");
    expect(args).toContain("-r");
    expect(args[args.indexOf("-r") + 1]).toBe("30");
    expect(args).toContain("+faststart");
  });

  it("builds motion, speed, VFR and audio policy chains", () => {
    const plan = samplePlan({
      segments: [
        { id: "flow", role: "crash", startFrame: 30, endFrame: 60, speed: 0.5, motion: "flow", audio: "pitch" },
        { id: "blend", role: "custom", startFrame: 0, endFrame: 30, speed: 0.25, motion: "blend", audio: "source" },
        { id: "mute", role: "body", startFrame: 60, endFrame: 90, speed: 2, motion: "repeat", audio: "mute" },
      ],
    });
    const graph = buildSegmentFilterGraph(plan, { inputPath: "/in.mp4", variableFrameRate: true });
    expect(segmentPictureFilters(plan.segments[0]!, 30, { variableFrameRate: true })).toEqual([
      "setpts=PTS-STARTPTS",
      "fps=fps=30",
      "minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1",
      "setpts=PTS/0.5",
      "fps=30",
      "trim=end_frame=60",
      "format=yuv420p",
      "setsar=1",
    ]);
    const filter = graph.filterParts.join(";");
    expect(filter).toContain("minterpolate=fps=120:mi_mode=blend");
    expect(filter).toContain("asetrate=24000,aresample=48000");
    expect(filter).toContain("atempo=0.5,atempo=0.5");
    expect(filter).toContain("anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=0.5,asetpts=PTS-STARTPTS[a2]");
  });

  it("omits audio chains and maps -an when the source has no sound", () => {
    const silent = samplePlan({ source: { ...samplePlan().source, hasAudio: false } });
    const args = buildSegmentRenderArgs(silent, {
      inputPath: "/in.mp4",
      outputPath: "/out.mp4",
      variableFrameRate: false,
    });
    expect(args).toContain("-an");
    const filter = args[args.indexOf("-filter_complex") + 1]!;
    expect(filter).toContain("[v0][v1]concat=n=2:v=1:a=0[vout]");
    expect(filter).not.toContain("[a0]");
  });
});

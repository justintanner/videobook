import { describe, expect, it } from "vitest";
import { FFMPEG, runFfmpeg } from "./ffmpeg.js";
import {
  AUDIO_SYNC_STRETCH_MAX,
  AUDIO_SYNC_STRETCH_MIN,
  buildAudioSyncSetptsExpression,
  buildAudioSyncVideoFilter,
  createAudioSyncPlan,
  evaluateAudioSyncDerivative,
  evaluateAudioSyncMap,
  type AudioSyncPlanInput,
} from "./audio-sync.js";

const canonicalInput: AudioSyncPlanInput = {
  videoDuration: 10,
  audioDuration: 10,
  sourceFps: 24,
  anchors: [
    { videoSeconds: 3, audioSeconds: 3.879 },
    { videoSeconds: 6, audioSeconds: 5.96 },
  ],
};

describe("createAudioSyncPlan", () => {
  it("adds endpoints and passes exactly through every anchor", () => {
    const plan = createAudioSyncPlan(canonicalInput);

    expect(plan.anchors).toEqual([
      { videoSeconds: 0, audioSeconds: 0 },
      ...canonicalInput.anchors,
      { videoSeconds: 10, audioSeconds: 10 },
    ]);
    for (const anchor of plan.anchors) {
      expect(evaluateAudioSyncMap(plan, anchor.videoSeconds)).toBeCloseTo(anchor.audioSeconds, 10);
    }
  });

  it("does not duplicate explicitly supplied endpoints", () => {
    const plan = createAudioSyncPlan({
      videoDuration: 5,
      audioDuration: 6,
      sourceFps: 30,
      anchors: [
        { videoSeconds: 0, audioSeconds: 0 },
        { videoSeconds: 3, audioSeconds: 4 },
        { videoSeconds: 5, audioSeconds: 6 },
      ],
    });

    expect(plan.anchors).toHaveLength(3);
    expect(plan.segments).toHaveLength(2);
  });

  it("builds a monotone C1 map whose derivative stays in range", () => {
    const plan = createAudioSyncPlan(canonicalInput);

    for (let index = 0; index < plan.segments.length - 1; index++) {
      expect(plan.segments[index].endDerivative)
        .toBeCloseTo(plan.segments[index + 1].startDerivative, 12);
    }

    let previous = evaluateAudioSyncMap(plan, 0);
    for (let frame = 1; frame <= canonicalInput.videoDuration * canonicalInput.sourceFps; frame++) {
      const timestamp = frame / canonicalInput.sourceFps;
      const mapped = evaluateAudioSyncMap(plan, timestamp);
      const derivative = evaluateAudioSyncDerivative(plan, timestamp);
      expect(mapped).toBeGreaterThan(previous);
      expect(derivative).toBeGreaterThanOrEqual(AUDIO_SYNC_STRETCH_MIN - 1e-9);
      expect(derivative).toBeLessThanOrEqual(AUDIO_SYNC_STRETCH_MAX + 1e-9);
      previous = mapped;
    }
  });

  it("supports a duration-only retime with implicit endpoints", () => {
    const plan = createAudioSyncPlan({
      videoDuration: 4,
      audioDuration: 5,
      sourceFps: 25,
      anchors: [],
    });

    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0].durationFactor).toBe(1.25);
    expect(evaluateAudioSyncMap(plan, 2)).toBeCloseTo(2.5, 12);
  });

  it.each([
    {
      input: { ...canonicalInput, videoDuration: 0 },
      message: "Video duration",
    },
    {
      input: { ...canonicalInput, audioDuration: Number.NaN },
      message: "finite",
    },
    {
      input: { ...canonicalInput, sourceFps: 0 },
      message: "frame rate",
    },
    {
      input: {
        ...canonicalInput,
        anchors: [{ videoSeconds: -1, audioSeconds: 1 }],
      },
      message: "within the video duration",
    },
    {
      input: {
        ...canonicalInput,
        anchors: [{ videoSeconds: 1, audioSeconds: 11 }],
      },
      message: "within the audio duration",
    },
    {
      input: {
        ...canonicalInput,
        anchors: [
          { videoSeconds: 3, audioSeconds: 2 },
          { videoSeconds: 2, audioSeconds: 4 },
        ],
      },
      message: "strictly increasing",
    },
    {
      input: {
        ...canonicalInput,
        anchors: [
          { videoSeconds: 3, audioSeconds: 2 },
          { videoSeconds: 3, audioSeconds: 2 },
        ],
      },
      message: "strictly increasing",
    },
    {
      input: {
        ...canonicalInput,
        anchors: [
          { videoSeconds: 0, audioSeconds: 0 },
          { videoSeconds: 0, audioSeconds: 0 },
        ],
      },
      message: "strictly increasing",
    },
  ])("rejects invalid plan input %#", ({ input, message }) => {
    expect(() => createAudioSyncPlan(input)).toThrow(message);
  });

  it("rejects source or output intervals shorter than one frame", () => {
    expect(() => createAudioSyncPlan({
      videoDuration: 2,
      audioDuration: 2,
      sourceFps: 30,
      anchors: [{ videoSeconds: 0.01, audioSeconds: 0.02 }],
    })).toThrow("at least one source frame");

    expect(() => createAudioSyncPlan({
      videoDuration: 2,
      audioDuration: 2,
      sourceFps: 30,
      anchors: [{ videoSeconds: 0.2, audioSeconds: 0.01 }],
    })).toThrow("at least one source frame");
  });

  it("rejects segment duration factors outside the safe range", () => {
    expect(() => createAudioSyncPlan({
      videoDuration: 2,
      audioDuration: 2,
      sourceFps: 30,
      anchors: [{ videoSeconds: 1, audioSeconds: 0.2 }],
    })).toThrow("duration factor");

    expect(() => createAudioSyncPlan({
      videoDuration: 2,
      audioDuration: 6,
      sourceFps: 30,
      anchors: [{ videoSeconds: 1, audioSeconds: 5 }],
    })).toThrow("duration factor");
  });

  it("rejects an identity map", () => {
    expect(() => createAudioSyncPlan({
      videoDuration: 10,
      audioDuration: 10,
      sourceFps: 30,
      anchors: [{ videoSeconds: 3, audioSeconds: 3 }],
    })).toThrow("no-op");
  });

  it("rejects a PCHIP whose analytical derivative exceeds safe rates", () => {
    expect(() => createAudioSyncPlan({
      videoDuration: 2,
      audioDuration: 4.25,
      sourceFps: 30,
      anchors: [{ videoSeconds: 1, audioSeconds: 0.25 }],
    })).toThrow("Smooth retiming rate");
  });

  it("rejects evaluation outside the planned source timeline", () => {
    const plan = createAudioSyncPlan(canonicalInput);
    expect(() => evaluateAudioSyncMap(plan, -1)).toThrow("within");
    expect(() => evaluateAudioSyncDerivative(plan, 11)).toThrow("within");
  });
});

describe("audio-sync FFmpeg filter", () => {
  it("builds one setpts mapping followed by source-FPS CFR, padding, and trimming", () => {
    const plan = createAudioSyncPlan(canonicalInput);
    const expression = buildAudioSyncSetptsExpression(plan);
    const filter = buildAudioSyncVideoFilter(plan);

    expect(expression).toContain("if(lte(");
    expect(filter.match(/setpts=/g)).toHaveLength(1);
    expect(filter).toContain("fps=fps=24");
    expect(filter).toContain("tpad=stop_mode=clone");
    expect(filter).toContain("trim=duration=10[vout]");
    expect(filter).not.toContain("minterpolate");
    expect(filter).not.toContain("atempo");
  });

  it("is accepted as a real FFmpeg filter graph", async () => {
    expect(FFMPEG).toBeTruthy();
    const plan = createAudioSyncPlan({
      videoDuration: 2,
      audioDuration: 2.5,
      sourceFps: 30,
      anchors: [{ videoSeconds: 0.75, audioSeconds: 1.1 }],
    });

    await expect(runFfmpeg([
      "-v", "error",
      "-f", "lavfi",
      "-i", "testsrc=duration=2:size=64x64:rate=30",
      "-filter_complex", buildAudioSyncVideoFilter(plan),
      "-map", "[vout]",
      "-f", "null",
      "-",
    ])).resolves.toBeUndefined();
  });
});

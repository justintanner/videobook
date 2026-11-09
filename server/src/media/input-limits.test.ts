import { describe, expect, it } from "vitest";
import { MODEL_ENTRIES } from "./catalog.js";
import { resolveModel } from "./descriptor.js";
import { inputLimitCap, inputLimitViolations, type InputCounts } from "./input-limits.js";
import { previewGeneration } from "./preview.js";
import type { RefParams } from "./request.js";
import type { MediaRefs, RefRole } from "./types.js";

interface LimitProbe {
  model: string;
  mode?: string;
  options: Record<string, unknown>;
  refParams?: RefParams;
  within: InputCounts;
  beyond: InputCounts;
}

const PROBES: readonly LimitProbe[] = [
  { model: "kie:grok-imagine-video-1-5-preview", mode: "i2v", options: { resolution: "1080p" }, within: { image: 1 }, beyond: { image: 2 } },
  { model: "kie:grok-imagine/image-to-video", options: { resolution: "1080p" }, within: { image: 1 }, beyond: { image: 2 } },
  { model: "kie:bytedance/seedance-2-5", mode: "i2v", options: {}, within: { first_frame: 1, last_frame: 1 }, beyond: { last_frame: 1 } },
  { model: "kie:gemini-omni-video", mode: "v2v", options: {}, within: { image: 5, video: 1 }, beyond: { image: 6, video: 1 } },
  { model: "kie:kling-4.0/keyframe-to-video", options: { duration: 5 }, within: { first_frame: 1, image: 4, last_frame: 1 }, beyond: { first_frame: 1, image: 5, last_frame: 1 } },
  {
    model: "wavespeed:runwayml/aleph-2",
    options: {},
    refParams: { keyframe: [1, 2, 3, 4].map((timestamp_s) => ({ timestamp_s })) },
    within: { video: 1, first_frame: 1, keyframe: 3, last_frame: 1 },
    beyond: { video: 1, first_frame: 1, keyframe: 4, last_frame: 1 },
  },
];

const EXTENSIONS: Readonly<Record<RefRole, string>> = {
  image: "png",
  first_frame: "png",
  last_frame: "png",
  loop: "png",
  keyframe: "png",
  video: "mp4",
  audio: "mp3",
};

function refsFor(counts: InputCounts): MediaRefs {
  return Object.fromEntries(Object.entries(counts).map(([role, count]) => [
    role,
    Array.from({ length: count ?? 0 }, (_, index) => `https://example.com/${role}-${index + 1}.${EXTENSIONS[role as RefRole]}`),
  ])) as Partial<Record<RefRole, string[]>>;
}

function preview(probe: LimitProbe, counts: InputCounts) {
  return previewGeneration({
    model: probe.model,
    prompt: "A probe prompt",
    refs: refsFor(counts),
    options: probe.options,
    ...(probe.mode ? { mode: probe.mode } : {}),
    ...(probe.refParams ? { ref_params: probe.refParams } : {}),
  });
}

describe("declared input limits", () => {
  it("probes every model that declares a limit", () => {
    const declared = MODEL_ENTRIES.filter((entry) => (entry.inputLimits ?? []).length > 0).map((entry) => entry.id).sort();
    expect(PROBES.map((probe) => probe.model).sort()).toEqual(declared);
  });

  it.each(PROBES)("$model accepts inputs at its limit and refuses one past it, like apicity", (probe) => {
    const model = resolveModel(probe.model);
    const limits = model.entry.inputLimits ?? [];
    const options = { ...model.entry.defaults, ...probe.options };

    expect(inputLimitViolations(limits, probe.within, options)).toEqual([]);
    expect(inputLimitViolations(limits, probe.beyond, options)).toEqual(limits.map((limit) => limit.message));
    expect(preview(probe, probe.within)).toMatchObject({ ok: true });
    expect(preview(probe, probe.beyond)).toMatchObject({ ok: false });
  });

  it("applies setting-dependent caps only under their setting", () => {
    const grok = resolveModel("kie:grok-imagine-video-1-5-preview");
    const [limit] = grok.entry.inputLimits ?? [];
    expect(inputLimitCap(limit!, { resolution: "1080p" })).toBe(1);
    expect(inputLimitCap(limit!, { resolution: "720p" })).toBeNull();
    expect(inputLimitViolations(grok.entry.inputLimits ?? [], { image: 3 }, { resolution: "720p" })).toEqual([]);
    const kling = resolveModel("kie:kling-4.0/keyframe-to-video");
    expect(inputLimitCap(kling.entry.inputLimits![0]!, { duration: 15 })).toBe(10);
    expect(inputLimitCap(kling.entry.inputLimits![0]!, { duration: "4" })).toBe(5);
  });
});

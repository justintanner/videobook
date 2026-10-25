import { describe, expect, it } from "vitest";
import type { NotebookCell } from "videobook-engine";
import { buildGoalPlanV3, compileGoalV3Steps, goalPlanV3Schema } from "./goal-plan-v3.js";
import { goalContent } from "./goal-store.js";
import {
  LIGHTNING_SCENE_MODEL,
  LIGHTNING_SCENE_OUTPUT_FORMAT,
  LIGHTNING_SCENE_RESOLUTION,
  LIGHTNING_VIDEO_GENERATE_AUDIO,
  LIGHTNING_VIDEO_MODEL,
  LIGHTNING_VIDEO_OUTPUT_FORMAT,
  LIGHTNING_VIDEO_RESOLUTION,
} from "./lightning-defaults.js";

const brief = "@a1 @a2 skate through the morning market";
const skater = {
  kind: "image", artifactId: "019a1f3e-5b10-7c2a-9d41-3f6b2a8c1e01", cellId: "019a1f3e-5b10-7c2a-9d41-3f6b2a8c1e11",
  address: "@a1", label: "Skater", objectHash: "1".repeat(64), slot: "@image1",
} as const;
const market = {
  kind: "image", artifactId: "019a1f3e-5b10-7c2a-9d41-3f6b2a8c1e02", cellId: "019a1f3e-5b10-7c2a-9d41-3f6b2a8c1e12",
  address: "@a2", label: "Market", objectHash: "2".repeat(64), slot: "@image2",
} as const;

const savedByVideobook030 = {
  version: 3,
  title: "skate through the morning market",
  aspectRatio: "16:9",
  scene: {
    prompt: "skate through the morning market @image1 @image2",
    tool: "generate_image",
    model: "kie:nano-banana-2-1",
    aspectRatio: "16:9",
    resolution: "2K",
    outputFormat: "jpg",
    imageRefs: [skater, market],
  },
  video: {
    prompt: "skate through the morning market @image1 @image2",
    tool: "generate_video",
    model: "kie:bytedance/seedance-2-5",
    aspectRatio: "16:9",
    resolution: "1080p",
    durationSeconds: 13,
    generateAudio: true,
    outputFormat: "mp4",
    imageRefs: [skater, market],
    videoRefs: [],
  },
  references: [skater, market],
  sampledFrames: [],
  finish: {
    suggestedColdOpenSeconds: 2.3,
    watermark: {
      platform: "tiktok", handle: "jtbkk", profileUrl: "https://www.tiktok.com/@jtbkk", mode: "burn",
      handleEndSeconds: 3, qrLeadSeconds: 2.3, handleOpacity: 0.28, qrOpacity: 0.37, fadeSeconds: 0.3,
    },
  },
};

const SAVED_SETTINGS = [
  { field: "scene.model", compiledAs: "model", lightning: LIGHTNING_SCENE_MODEL, saved: ["kie:nano-banana-2-1"] },
  { field: "scene.resolution", compiledAs: "options.resolution", lightning: LIGHTNING_SCENE_RESOLUTION, saved: ["2K", "4K"] },
  { field: "scene.outputFormat", compiledAs: "options.output_format", lightning: LIGHTNING_SCENE_OUTPUT_FORMAT, saved: ["jpg"] },
  { field: "video.model", compiledAs: "model", lightning: LIGHTNING_VIDEO_MODEL, saved: ["kie:bytedance/seedance-2-5"] },
  { field: "video.resolution", compiledAs: "options.resolution", lightning: LIGHTNING_VIDEO_RESOLUTION, saved: ["1080p"] },
  { field: "video.generateAudio", compiledAs: "options.generate_audio", lightning: LIGHTNING_VIDEO_GENERATE_AUDIO, saved: [true] },
  { field: "video.outputFormat", compiledAs: "options.output_format", lightning: LIGHTNING_VIDEO_OUTPUT_FORMAT, saved: ["mp4"] },
] as const;

function valueAt(value: unknown, path: string): unknown {
  return path.split(".").reduce((current, key) => (current as Record<string, unknown> | undefined)?.[key], value);
}

function savedWith(field: string, value: string | boolean): unknown {
  const [stage, key] = field.split(".") as ["scene" | "video", string];
  return { ...savedByVideobook030, [stage]: { ...savedByVideobook030[stage], [key]: value } };
}

function goalCell(plan: unknown): NotebookCell {
  return {
    id: "019a1f3e-5b10-7c2a-9d41-3f6b2a8c1e20", type: "goal", slot: { row: 1, column: 0 }, prompt: brief,
    inputs: { goalId: "019a1f3e-5b10-7c2a-9d41-3f6b2a8c1e21", revision: 1, plan },
  };
}

describe("saved v3 goal settings", () => {
  it.each(SAVED_SETTINGS)("loads and generates v3 goals saved with every $field value", ({ field, compiledAs, saved }) => {
    for (const value of saved) {
      const stored = savedWith(field, value);
      const { plan } = goalContent(goalCell(stored));
      expect(plan, `a goal saved with ${field} ${String(value)} must keep loading`).toEqual(stored);
      if (!plan || !("version" in plan) || plan.version !== 3) throw new Error("expected a v3 plan");
      expect(goalPlanV3Schema.parse(plan)).toEqual(stored);
      const step = compileGoalV3Steps(plan).find(candidate => candidate.id === field.split(".")[0]);
      expect(valueAt(step?.params, compiledAs)).toBe(value);
    }
  });

  it.each(SAVED_SETTINGS)("records the current Lightning $field among the saved values", ({ field, lightning, saved }) => {
    expect(saved, `New v3 goals now save ${field} ${String(lightning)}. Accept it in goalPlanV3Schema next to every earlier value, so goals saved before the change keep loading, then add it here.`).toContain(lightning);
  });

  it("saves the current Lightning settings on a new v3 goal", () => {
    const plan = buildGoalPlanV3({ brief, references: [skater, market], frame: null });
    for (const { field, lightning } of SAVED_SETTINGS) expect(valueAt(plan, field), field).toBe(lightning);
  });
});

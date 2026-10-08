import { describe, expect, it } from "vitest";
import { z } from "zod";
import { goalBriefConstraints, goalPlanSchema, goalPlannerResponseSchema } from "./goal-plan.js";
import { constrainGoalPlannerPlan, goalPlannerInstructions } from "./goal-planner-prompt.js";
import { goalBriefStyle, goalStyle } from "./goal-styles.js";

const plan = goalPlanSchema.parse({
  version: 2, title: "Morning", continuity: "Character 1 at home.", aspectRatio: "16:9", imageModel: "flare", imageResolution: "1K", videoResolution: "480p", frameContinuity: true,
  frame: { prompt: "Character 1 in a sunlit room." },
  shots: [1, 2].map(() => ({ title: "Get ready", storyboardPrompt: "1 cleanse, 2 dress, 3 smile, 4 mirror", videoPrompt: "Character 1 puts on a jacket; room ambience.", endingPrompt: "A smile.", durationSeconds: 10 })),
});

describe("goal planner style guidance", () => {
  it("requests barebones storyboard-led prompts with small word ceilings", () => {
    const text = goalPlannerInstructions({ id: "cinematic", options: {} }, goalBriefConstraints("two clips"));
    expect(text).toContain("short noun/verb fragments");
    expect(text).toContain("Let the storyboard guide the video");
    expect(text).toContain("do not retell the panels");
    expect(text).toContain("ceilings, not targets");
    expect(text).toContain("video 12");
  });

  it("guides every content format with four beats and the selected phone options", () => {
    const style = goalStyle("ig-influencer");
    for (const format of style.options.find(option => option.key === "format")!.choices) {
      const selection = { id: style.id, options: { format: format.value, delivery: "mirror", camera: "iphone-main", light: "golden-hour" } };
      const text = goalPlannerInstructions(selection, goalBriefConstraints("two clips square"));
      for (const anchor of ["hyper-realistic", "visible pores", "captions or on-screen text", "ambient room or street sound", "optional short spoken line", "Mirror", "iPhone main camera", "Golden hour", "Use 1:1", format.beats!]) expect(text.toLowerCase()).toContain(anchor.toLowerCase());
      for (const word of style.banned) expect(text).toContain(word);
    }
  });

  it("forces the detected style and defaults while preserving explicitly requested settings", () => {
    const style = goalBriefStyle("IG influencer GRWM");
    const constrained = constrainGoalPlannerPlan(plan, "two 4s clips", style);
    expect(constrained).toMatchObject({ style, aspectRatio: "9:16", imageModel: "sunburst", imageResolution: "2K", videoResolution: "720p", frameContinuity: false });
    expect(constrained.shots.map(shot => [shot.durationSeconds, shot.endingPrompt])).toEqual([[4, null], [4, null]]);
    expect(constrainGoalPlannerPlan(plan, "two 4s clips square, Flare 1K images and 480p video", style)).toMatchObject({ aspectRatio: "1:1", imageModel: "flare", imageResolution: "1K", videoResolution: "480p" });
    expect(() => constrainGoalPlannerPlan(plan, "three clips", style)).toThrow("different shot count");
    expect(plan.frameContinuity).toBe(true);
  });

  it("keeps provider output schemas closed and attaches the selected style server-side", () => {
    const schema = z.toJSONSchema(goalPlannerResponseSchema.omit({ style: true }));
    expect(schema.properties).not.toHaveProperty("style");
    expect(schema.additionalProperties).toBe(false);
    expect(goalPlannerResponseSchema.parse(plan).style).toEqual({ id: "cinematic", options: {} });
  });
});

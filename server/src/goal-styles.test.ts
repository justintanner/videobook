import { describe, expect, it } from "vitest";
import { GOAL_STYLE_IDS, goalStyle, goalStyleFragment, goalStyleSummary, resolveGoalStyleOptions } from "./goal-styles.js";
import type { GoalStyleStage } from "./goal-styles.js";
import { goalPromptWords } from "./goal-prompt-budget.js";

const limits: Record<GoalStyleStage, number> = { frame: 25, storyboard: 20, ending: 15, video: 20, revise: 15 };

describe("goal styles", () => {
  it("keeps cinematic prompts empty and exposes the two styles", () => {
    expect(GOAL_STYLE_IDS).toEqual(["cinematic", "ig-influencer"]);
    expect(goalStyle("cinematic")).toMatchObject({ defaults: {}, banned: [], options: [], planner: "" });
    expect(resolveGoalStyleOptions("cinematic")).toEqual({});
    for (const stage of Object.keys(limits) as GoalStyleStage[]) {
      expect(goalStyleFragment({ id: "cinematic", options: {} }, stage)).toBe("");
    }
  });

  it("resolves all defaults and lets the camera follow delivery unless explicitly chosen", () => {
    expect(resolveGoalStyleOptions("ig-influencer")).toEqual({
      format: "day-in-the-life", delivery: "selfie-to-camera", camera: "iphone-front", light: "soft-daylight",
    });
    for (const delivery of ["filmed-by-friend", "tripod", "mirror"]) {
      expect(resolveGoalStyleOptions("ig-influencer", { delivery }).camera).toBe("iphone-main");
      expect(resolveGoalStyleOptions("ig-influencer", { delivery, camera: "iphone-front" }).camera).toBe("iphone-front");
    }
    expect(goalStyleSummary({ id: "ig-influencer", options: { format: "grwm" } })).toBe("IG Influencer · GRWM · Selfie to camera · iPhone front camera · Soft daylight");
  });

  it("rejects unknown keys and values with readable option errors", () => {
    expect(() => resolveGoalStyleOptions("cinematic", { format: "grwm" })).toThrow("Unknown Cinematic option: format");
    expect(() => resolveGoalStyleOptions("ig-influencer", { typo: "grwm" })).toThrow("Unknown IG Influencer option: typo");
    expect(() => resolveGoalStyleOptions("ig-influencer", { format: "unknown" })).toThrow("Invalid IG Influencer Content format: unknown");
  });

  it("keeps every option combination within stage budgets and free of banned language or references", () => {
    const style = goalStyle("ig-influencer");
    const combinations = style.options.reduce<Record<string, string>[]>((previous, option) =>
      previous.flatMap(options => option.choices.map(choice => ({ ...options, [option.key]: choice.value }))), [{}]);
    for (const options of combinations) {
      for (const stage of Object.keys(limits) as GoalStyleStage[]) {
        const fragment = goalStyleFragment({ id: style.id, options }, stage);
        expect(goalPromptWords(fragment), fragment).toBeLessThanOrEqual(limits[stage]);
        expect(fragment).toContain("hyper-realistic");
        expect(fragment).toContain("pores");
        expect(fragment).not.toMatch(/@|\b(?:grid|panels?|captions?)\b/iu);
        for (const word of style.banned) expect(fragment.toLowerCase()).not.toContain(word.toLowerCase());
        for (const option of style.options) expect(fragment).toContain(option.choices.find(choice => choice.value === options[option.key])!.prompt);
      }
    }
    const video = goalStyleFragment({ id: style.id, options: {} }, "video");
    expect(video).toMatch(/natural motion.*handheld micro-shake.*ambient sound.*optional short speech/u);
    expect(goalStyleFragment({ id: style.id, options: { delivery: "tripod" } }, "video")).toContain("steady framing");
  });
});

import { describe, expect, it } from "vitest";
import { GOAL_STYLE_IDS, goalBriefStyle, goalStyle, goalStyleFragment, goalStyleSummary, resolveGoalStyleOptions } from "./goal-styles.js";
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

  it("detects every style and option keyword with mixed case and whole words", () => {
    for (const id of GOAL_STYLE_IDS) {
      for (const keyword of goalStyle(id).briefKeywords) expect(goalBriefStyle(`@a1 as an ${keyword.toUpperCase()}, morning routine`).id).toBe(id);
    }
    for (const option of goalStyle("ig-influencer").options) {
      for (const choice of option.choices) {
        for (const keyword of choice.briefKeywords) {
          expect(goalBriefStyle(`@a1 Instagram influencer, ${keyword.toUpperCase()}`).options[option.key]).toBe(choice.value);
        }
      }
    }
    expect(goalBriefStyle("@a1 as an IG influencer, GRWM morning routine, filmed by a friend, golden hour")).toEqual({
      id: "ig-influencer", options: { format: "grwm", delivery: "filmed-by-friend", camera: "iphone-main", light: "golden-hour" },
    });
    expect(goalBriefStyle("IG influencer day-in-the-life").options.format).toBe("day-in-the-life");
    expect(goalBriefStyle("IG influencer GRWM skincare").options.format).toBe("grwm");
    expect(goalBriefStyle("IG influencer skincare GRWM").options.format).toBe("skincare");
    expect(goalBriefStyle("Cinematic first, then IG influencer").id).toBe("cinematic");
    expect(goalBriefStyle("IG influencer first, then cinematic").id).toBe("ig-influencer");
  });

  it("leaves unrelated briefs and embedded character names cinematic; standalone style words still select a style", () => {
    for (const brief of ["@a1 rides a skateboard", "@a1 Superinfluencer visits the gym", "@a1 influencerella vlog", "@a1 my_influencer travels", "@a1 influencer-robot storytime"]) {
      expect(goalBriefStyle(brief)).toEqual({ id: "cinematic", options: {} });
    }
    expect(goalBriefStyle('@a1 named "Influencer" visits a cafe').id).toBe("ig-influencer");
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
    expect(video).toMatch(/natural motion.*handheld micro-shake.*ambient sound/u);
    expect(goalStyleFragment({ id: style.id, options: { delivery: "tripod" } }, "video")).toContain("steady framing");
  });
});

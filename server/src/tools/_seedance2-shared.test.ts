import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildSeedance2Schema,
  seedanceActorReplacementPrompt,
} from "./_seedance2-shared.js";

const guide = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../guides/seedance_2_prompting_guide.md"),
  "utf8",
);

describe("buildSeedance2Schema", () => {
  it("derives the regular model contract from Apicity", () => {
    const schema = buildSeedance2Schema("bytedance/seedance-2");

    expect(schema.prompt.safeParse("ab").success).toBe(false);
    expect(schema.prompt.safeParse("describe a scene").success).toBe(true);
    expect(schema.resolution.safeParse("1080p").success).toBe(true);
    expect(schema.duration.safeParse("4").success).toBe(true);
    expect(schema.duration.safeParse("15").success).toBe(true);
    expect(schema.duration.safeParse("16").success).toBe(false);
  });

  it("keeps the Fast model resolution and reference limits distinct", () => {
    const schema = buildSeedance2Schema("bytedance/seedance-2-fast");

    expect(schema.resolution.safeParse("720p").success).toBe(true);
    expect(schema.resolution.safeParse("1080p").success).toBe(false);
    expect(schema.video_refs.safeParse(["@vid-a", "@vid-b", "@vid-c"]).success).toBe(true);
    expect(schema.video_refs.safeParse(["@vid-a", "@vid-b", "@vid-c", "@vid-d"]).success).toBe(false);
  });
});

describe("seedanceActorReplacementPrompt", () => {
  it("maps each identity still onto an on-screen person in @Video1", () => {
    const prompt = seedanceActorReplacementPrompt(3);
    expect(prompt).toBe(
      "Replace the on-screen person matching @Image1 with @Image1 as character reference. "
      + "Replace the on-screen person matching @Image2 with @Image2 as character reference. "
      + "Replace the on-screen person matching @Image3 with @Image3 as character reference. "
      + "Keep camera movement, pacing, and framing of @Video1.",
    );
    expect(guide).toContain(prompt);
    expect(guide).toContain("generate_kie_seedance_2_0_video");
    expect(guide).toContain("original.mp4");
  });
});

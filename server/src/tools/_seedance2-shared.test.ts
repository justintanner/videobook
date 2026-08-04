import { describe, expect, it } from "vitest";
import { buildSeedance2Schema } from "./_seedance2-shared.js";

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

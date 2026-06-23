import { describe, expect, it } from "vitest";
import { z } from "zod";
import { NanoBananaProRequestSchema } from "@apicity/kie/zod";
import { FalNanoBananaProTextToImageRequestSchema } from "@apicity/fal/zod";
import { zodDefault, zodIsRequired } from "./zod-slots.js";

describe("zod default and required helpers", () => {
  it("reads local Zod defaults and requiredness", () => {
    const withDefault = z.string().default("auto");

    expect(zodDefault(withDefault)).toEqual({ hasDefault: true, value: "auto" });
    expect(zodIsRequired(withDefault)).toBe(false);
    expect(zodIsRequired(z.string())).toBe(true);
    expect(zodIsRequired(z.string().optional())).toBe(false);
  });

  it("reads Apicity Zod defaults without using enum order as fallback", () => {
    expect(zodDefault(NanoBananaProRequestSchema.shape.input.shape.aspect_ratio)).toEqual({
      hasDefault: true,
      value: "16:9",
    });
    expect(zodDefault(FalNanoBananaProTextToImageRequestSchema.shape.aspect_ratio)).toEqual({
      hasDefault: false,
    });
  });
});

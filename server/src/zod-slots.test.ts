import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  GrokImageToVideoRequestSchema,
  NanoBananaProRequestSchema,
  Wan27TextToVideoRequestSchema,
  Wan27ResolutionSchema,
} from "@apicity/kie/zod";
import { AlibabaVideoSynthesisParametersSchema } from "@apicity/alibaba/zod";
import { FalNanoBananaProTextToImageRequestSchema } from "@apicity/fal/zod";
import {
  zodDefault,
  zodEnumOptionsOrNull,
  zodIsRequired,
  zodNumberRange,
  zodStringMaxLength,
  zodStringMinLength,
} from "./zod-slots.js";

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

describe("zodNumberRange", () => {
  it("reads a Zod 4 (kie) ZodNumber with int/min/max", () => {
    expect(zodNumberRange(Wan27TextToVideoRequestSchema.shape.input.shape.duration)).toEqual({
      min: 2,
      max: 15,
      int: true,
    });
  });

  it("reads the number branch of a Zod union (grok i2v duration)", () => {
    expect(zodNumberRange(GrokImageToVideoRequestSchema.shape.input.shape.duration)).toEqual({
      min: 6,
      max: 30,
      int: true,
    });
  });

  it("reads a Zod 3 (alibaba) ZodNumber with int/min/max", () => {
    expect(zodNumberRange(AlibabaVideoSynthesisParametersSchema.shape.duration)).toEqual({
      min: 2,
      max: 10,
      int: true,
    });
  });

  it("reads a local Zod number, defaulting int false", () => {
    expect(zodNumberRange(z.number().min(0).max(5))).toEqual({ min: 0, max: 5, int: false });
    expect(zodNumberRange(z.number().int().optional())).toEqual({ min: undefined, max: undefined, int: true });
  });

  it("returns null for non-number schemas", () => {
    expect(zodNumberRange(z.string())).toBeNull();
    expect(zodNumberRange(Wan27ResolutionSchema)).toBeNull();
    expect(zodNumberRange(null)).toBeNull();
  });
});

describe("zodStringMaxLength / zodStringMinLength", () => {
  it("reads string bounds from an Apicity (Zod 4) field", () => {
    const prompt = Wan27TextToVideoRequestSchema.shape.input.shape.prompt;
    expect(zodStringMaxLength(prompt)).toBe(5000);
    expect(zodStringMinLength(prompt)).toBe(1);
  });

  it("reads a local string and returns undefined when unconstrained", () => {
    expect(zodStringMaxLength(z.string().max(42).optional())).toBe(42);
    expect(zodStringMaxLength(z.string())).toBeUndefined();
    expect(zodStringMaxLength(z.number())).toBeUndefined();
  });
});

describe("zodEnumOptionsOrNull", () => {
  it("returns enum options for an Apicity enum field", () => {
    expect(zodEnumOptionsOrNull(Wan27ResolutionSchema)).toEqual(["720p", "1080p"]);
  });

  it("returns null for non-enum schemas instead of throwing", () => {
    expect(zodEnumOptionsOrNull(Wan27TextToVideoRequestSchema.shape.input.shape.duration)).toBeNull();
    expect(zodEnumOptionsOrNull(z.string())).toBeNull();
    expect(zodEnumOptionsOrNull(null)).toBeNull();
  });
});

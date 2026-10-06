import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  GrokImageToVideoRequestSchema,
  HappyHorse11TextToVideoRequestSchema,
  NanoBananaProRequestSchema,
  Seedance2MiniInputSchema,
} from "@apicity/kie/zod";
import { XaiVideoGenerateRequestSchema } from "@apicity/xai/zod";
import { AlibabaVideoSynthesisParametersSchema } from "@apicity/alibaba/zod";
import {
  FalMinimaxH3MaxInsertVideoRequestSchema,
  FalNanoBananaProTextToImageRequestSchema,
} from "@apicity/fal/zod";
import {
  zodDefault,
  zodEnumOptionsOrNull,
  zodFiniteNumberOptions,
  zodIsRequired,
  zodNumberRange,
  readSlotConstraints,
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
    expect(zodIsRequired(z.string().nullable())).toBe(true);
    expect(zodIsRequired(z.string().nullable().optional())).toBe(false);
    expect(zodIsRequired(z.string().optional().nullable())).toBe(false);
    expect(zodIsRequired(z.string().nullable().default(null))).toBe(false);
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
    expect(zodNumberRange(HappyHorse11TextToVideoRequestSchema.shape.input.shape.duration)).toEqual({
      min: 3,
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

  it("reads the number branch of the Alibaba duration union", () => {
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

  it("keeps an exclusive lower bound distinct from an inclusive one", () => {
    expect(zodNumberRange(FalMinimaxH3MaxInsertVideoRequestSchema.shape.start_time)).toEqual({
      min: 1.625,
      max: 60,
      int: false,
    });
    expect(zodNumberRange(FalMinimaxH3MaxInsertVideoRequestSchema.shape.resume_time)).toEqual({
      min: 1.625,
      max: 60,
      exclusiveMin: true,
      int: false,
    });
  });

  it("returns null for non-number schemas", () => {
    expect(zodNumberRange(z.string())).toBeNull();
    expect(zodNumberRange(HappyHorse11TextToVideoRequestSchema.shape.input.shape.resolution)).toBeNull();
    expect(zodNumberRange(null)).toBeNull();
  });
});

describe("zodFiniteNumberOptions", () => {
  it("reads a union of numeric literals", () => {
    expect(zodFiniteNumberOptions(XaiVideoGenerateRequestSchema.shape.duration)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
  });

  it("combines literal and bounded integer branches", () => {
    expect(zodFiniteNumberOptions(AlibabaVideoSynthesisParametersSchema.shape.duration)).toEqual([
      0, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it("does not expand large or unbounded ranges", () => {
    expect(zodFiniteNumberOptions(z.number().int().min(0).max(2_000))).toBeNull();
    expect(zodFiniteNumberOptions(z.number().int())).toBeNull();
  });
});

describe("readSlotConstraints", () => {
  it("reads default-wrapped Apicity arrays as optional slots", () => {
    expect(readSlotConstraints(Seedance2MiniInputSchema.shape.reference_video_urls)).toEqual({ min: 0, max: 3 });
  });
});

describe("zodStringMaxLength / zodStringMinLength", () => {
  it("reads string bounds from an Apicity (Zod 4) field", () => {
    const prompt = HappyHorse11TextToVideoRequestSchema.shape.input.shape.prompt;
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
    expect(zodEnumOptionsOrNull(HappyHorse11TextToVideoRequestSchema.shape.input.shape.resolution)).toEqual(["720p", "1080p"]);
  });

  it("returns null for non-enum schemas instead of throwing", () => {
    expect(zodEnumOptionsOrNull(HappyHorse11TextToVideoRequestSchema.shape.input.shape.duration)).toBeNull();
    expect(zodEnumOptionsOrNull(z.string())).toBeNull();
    expect(zodEnumOptionsOrNull(null)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AlibabaVideoSynthesisModelSchema,
  AlibabaVideoSynthesisParametersSchema,
} from "@apicity/alibaba/zod";
import { FalQwenImageRequestSchema } from "@apicity/fal/zod";
import { Qwen2ImageEditRequestSchema, Seedance2MiniInputSchema } from "@apicity/kie/zod";
import { XaiVideoGenerateRequestSchema } from "@apicity/xai/zod";
import {
  apicityField,
  apicityStringArrayField,
  apicityStringNumberField,
  apicityUnionEnumField,
} from "./schema-from-apicity.js";

describe("schema-from-apicity", () => {
  it("preserves finite numeric unions without accepting gaps", () => {
    const field = apicityField(AlibabaVideoSynthesisParametersSchema.shape.duration);
    expect(field.safeParse("0").success).toBe(true);
    expect(field.safeParse("2").success).toBe(true);
    expect(field.safeParse("1").success).toBe(false);
    expect(field.safeParse("11").success).toBe(false);
  });

  it("converts finite numeric domains to string enums", () => {
    const field = apicityStringNumberField(XaiVideoGenerateRequestSchema.shape.duration);
    expect(field.safeParse("1").success).toBe(true);
    expect(field.safeParse("15").success).toBe(true);
    expect(field.safeParse("16").success).toBe(false);
  });

  it("copies array cardinality while accepting local asset slugs", () => {
    const field = apicityStringArrayField(Seedance2MiniInputSchema.shape.reference_video_urls);
    expect(field.safeParse(["@vid-one"]).success).toBe(true);
    expect(field.safeParse(["@vid-one", "@vid-two", "@vid-three", "@vid-four"]).success).toBe(false);
  });

  it("preserves the minimum for an optional array when a value is supplied", () => {
    const field = apicityStringArrayField(z.array(z.string()).min(1).max(2).optional());
    expect(field.safeParse(undefined).success).toBe(true);
    expect(field.safeParse([]).success).toBe(false);
    expect(field.safeParse(["@img-one"]).success).toBe(true);
  });

  it("maps a provider string input to exactly one local asset slot", () => {
    const field = apicityStringArrayField(Qwen2ImageEditRequestSchema.shape.input.shape.image_url);
    expect(field.safeParse(["@img-one"]).success).toBe(true);
    expect(field.safeParse([]).success).toBe(false);
    expect(field.safeParse(["@img-one", "@img-two"]).success).toBe(false);
  });

  it("extracts the enum branch from enum-or-custom-object unions", () => {
    const field = apicityUnionEnumField(FalQwenImageRequestSchema.shape.image_size);
    expect(field.safeParse("square_hd").success).toBe(true);
    expect(field.safeParse("not-a-size").success).toBe(false);
    expect(field.safeParse({ width: 1280, height: 720 }).success).toBe(false);
  });

  it("narrows enum-or-alias models to listed options", () => {
    const field = apicityUnionEnumField(AlibabaVideoSynthesisModelSchema);
    expect(field.safeParse("wan2.7-i2v").success).toBe(true);
    expect(field.safeParse("wan2.7-videoedit").success).toBe(true);
    expect(field.safeParse("wan3.0-i2v").success).toBe(false);
  });
});

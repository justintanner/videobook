import { z, type ZodObject, type ZodRawShape } from "zod";

const STORED_IMAGE_FORMATS = ["jpeg", "png", "webp"] as const;

export function storedImageFormats(schema: ZodObject<ZodRawShape>): ZodObject<ZodRawShape> {
  return schema.extend({
    output_format: z.enum(STORED_IMAGE_FORMATS).default("png").describe("Output format for the images"),
  });
}

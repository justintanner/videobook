import { NanoBanana21RequestSchema } from "@apicity/kie/zod";
import { DEFAULT_IMAGE_EDIT_MODEL_ID } from "./image-edit-default.js";

export function buildNanoBanana21Payload(args: Record<string, unknown>, imageUrls: readonly string[]) {
  if (imageUrls.length > 10) throw new Error("Nano Banana 2.1 accepts at most 10 reference images");
  const input = NanoBanana21RequestSchema.shape.input.omit({ image_input: true }).parse(args);
  return {
    model: DEFAULT_IMAGE_EDIT_MODEL_ID,
    input: {
      ...input,
      ...(imageUrls.length ? { image_input: [...imageUrls] } : {}),
    },
  };
}

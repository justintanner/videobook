import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { uploadAssetToFal } from "./_fal-upload.js";
import { submitFalJob } from "./_fal-shared.js";
import { requireApiKey } from "../api-key.js";

type RefInput = { assetId: string; filename: string };

type Payload = {
  type: "generate_nano_banana_2_lite_edit_fal";
  imgAssetId: string;
  imgAssetDir: string;
  bookId: string;
  prompt: string;
  imageInputs: RefInput[];
  sourceImageIds: string[];
  num_images?: number;
  aspect_ratio?: string;
  output_format?: string;
  safety_tolerance?: string;
  thinking_level?: string;
  seed?: number;
};

export function registerGenerateNanoBanana2LiteEditFalJob(fs: Engine): void {
  registerJobHandler("generate_nano_banana_2_lite_edit_fal", async (payload, ctx) => {
    requireApiKey("FAL_API_KEY");
    const p = payload as Payload;
    return withProviderHandoff(fs, p.bookId, p.imgAssetId, ctx, "generate", async (ownerId) => {

      const image_urls = await Promise.all(
        p.imageInputs.map((i) => uploadAssetToFal(fs, i.assetId, i.filename, p.bookId)),
      );

      const input: Record<string, unknown> = {
        prompt: p.prompt,
        image_urls,
        ...(p.num_images !== undefined ? { num_images: p.num_images } : {}),
        ...(p.aspect_ratio !== undefined ? { aspect_ratio: p.aspect_ratio } : {}),
        ...(p.output_format !== undefined ? { output_format: p.output_format } : {}),
        ...(p.safety_tolerance !== undefined ? { safety_tolerance: p.safety_tolerance } : {}),
        ...(p.thinking_level !== undefined ? { thinking_level: p.thinking_level } : {}),
        ...(p.seed !== undefined ? { seed: p.seed } : {}),
      };

      const taskId = await submitFalJob({
        fs,
        bookId: p.bookId,
        assetId: p.imgAssetId,
        assetDir: p.imgAssetDir,
        endpointId: "google/nano-banana-lite/edit",
        input,
        taskType: "fal_nano_banana_2_edit",
        meta: { prompt: p.prompt, sourceImageIds: p.sourceImageIds, aspectRatio: p.aspect_ratio, outputFormat: p.output_format, apiModel: "nano-banana-2-lite" },
        expectedOwnerId: ownerId,
      });

      return { taskId, result: { success: true, taskId } };
    });
  });
}

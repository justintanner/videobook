import type { FalEndpointInputMap } from "@apicity/fal";
import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { uploadAssetToFal } from "./_fal-upload.js";
import { submitFalJob } from "./_fal-shared.js";
import type { ImageInput } from "../tools/_image-inputs.js";

type FalInput = FalEndpointInputMap["alibaba/qwen-image-3/edit"];

type Payload = {
  type: "generate_qwen3_image_edit_fal";
  imgAssetId: string;
  imgAssetDir: string;
  bookId: string;
  prompt: string;
  imageInputs: ImageInput[];
  sourceImageIds: string[];
  negative_prompt?: string;
  image_size?: FalInput["image_size"];
  enable_prompt_expansion?: boolean;
  seed?: number;
  enable_safety_checker?: boolean;
  sync_mode?: boolean;
  num_images?: number;
  output_format?: FalInput["output_format"];
};

export function registerGenerateQwen3ImageEditFalJob(engine: Engine): void {
  registerJobHandler("generate_qwen3_image_edit_fal", async (payload, ctx) => {
    const p = payload as Payload;
    return withProviderHandoff(engine, p.imgAssetId, ctx, "generate", async (ownerId) => {

      const image_urls = await Promise.all(
        p.imageInputs.map((i) => "url" in i
          ? Promise.resolve(i.url)
          : uploadAssetToFal(engine, i.assetId, i.filename)),
      );

      const input: FalInput = {
        prompt: p.prompt,
        image_urls,
        ...(p.negative_prompt !== undefined ? { negative_prompt: p.negative_prompt } : {}),
        ...(p.image_size !== undefined ? { image_size: p.image_size } : {}),
        ...(p.enable_prompt_expansion !== undefined ? { enable_prompt_expansion: p.enable_prompt_expansion } : {}),
        ...(p.seed !== undefined ? { seed: p.seed } : {}),
        ...(p.enable_safety_checker !== undefined ? { enable_safety_checker: p.enable_safety_checker } : {}),
        ...(p.sync_mode !== undefined ? { sync_mode: p.sync_mode } : {}),
        ...(p.num_images !== undefined ? { num_images: p.num_images } : {}),
        ...(p.output_format !== undefined ? { output_format: p.output_format } : {}),
      };

      const taskId = await submitFalJob({
        engine,
        bookId: p.bookId,
        assetId: p.imgAssetId,
        assetDir: p.imgAssetDir,
        endpointId: "alibaba/qwen-image-3/edit",
        input,
        taskType: "fal_qwen3_image_edit",
        meta: {
          prompt: p.prompt,
          sourceImageIds: p.sourceImageIds,
          ...(p.output_format !== undefined ? { outputFormat: p.output_format } : {}),
          ...(p.seed !== undefined ? { seed: p.seed } : {}),
        },
        expectedOwnerId: ownerId,
      });

      return { taskId, result: { success: true, taskId } };    });
  });
}

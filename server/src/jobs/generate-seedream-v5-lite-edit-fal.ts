import type { ClipfirstFs } from "clipfirst-fs";
import { registerJobHandler } from "../queue.js";
import { uploadAssetToFal } from "./_fal-upload.js";
import { submitFalJob } from "./_fal-shared.js";
import type { ImageInput } from "../tools/_image-inputs.js";

type Payload = {
  type: "generate_seedream_v5_lite_edit_fal";
  imgAssetId: string;
  imgAssetDir: string;
  projectSlug: string;
  prompt: string;
  imageInputs: ImageInput[];
  sourceImageIds: string[];
  image_size?: string;
  num_images?: number;
  max_images?: number;
  seed?: number;
};

export function registerGenerateSeedreamV5LiteEditFalJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_seedream_v5_lite_edit_fal", async (payload) => {
    const p = payload as Payload;

    const image_urls = await Promise.all(
      p.imageInputs.map((i) =>
        "url" in i ? i.url : uploadAssetToFal(fs, i.assetId, i.filename, p.projectSlug),
      ),
    );

    const input: Record<string, unknown> = {
      prompt: p.prompt,
      image_urls,
      ...(p.image_size !== undefined ? { image_size: p.image_size } : {}),
      ...(p.num_images !== undefined ? { num_images: p.num_images } : {}),
      ...(p.max_images !== undefined ? { max_images: p.max_images } : {}),
      ...(p.seed !== undefined ? { seed: p.seed } : {}),
    };

    const taskId = await submitFalJob({
      fs,
      projectSlug: p.projectSlug,
      assetId: p.imgAssetId,
      assetDir: p.imgAssetDir,
      endpointId: "fal-ai/bytedance/seedream/v5/lite/edit",
      input,
      taskType: "fal_seedream_v5_lite_edit",
      meta: {
        prompt: p.prompt,
        sourceImageIds: p.sourceImageIds,
        ...(p.image_size !== undefined ? { imageSize: p.image_size } : {}),
        ...(p.seed !== undefined ? { seed: p.seed } : {}),
      },
    });

    return { success: true, taskId };
  });
}

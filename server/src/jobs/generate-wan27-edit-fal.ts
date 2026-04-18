import type { ClipfirstFs } from "clipfirst-fs";
import { registerJobHandler } from "../queue.js";
import { uploadAssetFile } from "../upload.js";
import { submitFalJob } from "./_fal-shared.js";

type ImageInput = { assetId: string; filename: string };

type Payload = {
  type: "generate_wan27_edit_fal";
  imgAssetId: string;
  imgAssetDir: string;
  projectSlug: string;
  prompt: string;
  imageInputs: ImageInput[];
  sourceImageIds: string[];
  negative_prompt?: string;
  image_size?: string;
  num_images?: number;
  seed?: number;
};

export function registerGenerateWan27EditFalJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_wan27_edit_fal", async (payload) => {
    const p = payload as Payload;

    const image_urls = await Promise.all(
      p.imageInputs.map((i) => uploadAssetFile(fs, i.assetId, i.filename, p.projectSlug)),
    );

    const input: Record<string, unknown> = {
      prompt: p.prompt,
      image_urls,
      ...(p.negative_prompt !== undefined ? { negative_prompt: p.negative_prompt } : {}),
      ...(p.image_size !== undefined ? { image_size: p.image_size } : {}),
      ...(p.num_images !== undefined ? { num_images: p.num_images } : {}),
      ...(p.seed !== undefined ? { seed: p.seed } : {}),
    };

    const taskId = await submitFalJob({
      fs,
      projectSlug: p.projectSlug,
      assetId: p.imgAssetId,
      assetDir: p.imgAssetDir,
      endpointId: "fal-ai/wan/v2.7/edit",
      input,
      taskType: "fal_wan27_edit",
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

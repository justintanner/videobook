import type { ClipfirstFs } from "clipfirst-fs";
import { registerJobHandler } from "../queue.js";
import { uploadAssetToFal } from "./_fal-upload.js";
import { submitFalJob } from "./_fal-shared.js";

type ImageInput = { assetId: string; filename: string };

type Payload = {
  type: "generate_gpt_image_1_5_edit_fal";
  imgAssetId: string;
  imgAssetDir: string;
  projectSlug: string;
  prompt: string;
  imageInputs: ImageInput[];
  sourceImageIds: string[];
  image_size?: string;
  background?: string;
  quality?: string;
  num_images?: number;
  input_fidelity?: string;
  output_format?: string;
};

export function registerGenerateGptImage1p5EditFalJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_gpt_image_1_5_edit_fal", async (payload) => {
    const p = payload as Payload;

    const image_urls = await Promise.all(
      p.imageInputs.map((i) => uploadAssetToFal(fs, i.assetId, i.filename, p.projectSlug)),
    );

    const input: Record<string, unknown> = {
      prompt: p.prompt,
      image_urls,
      ...(p.image_size !== undefined ? { image_size: p.image_size } : {}),
      ...(p.background !== undefined ? { background: p.background } : {}),
      ...(p.quality !== undefined ? { quality: p.quality } : {}),
      ...(p.num_images !== undefined ? { num_images: p.num_images } : {}),
      ...(p.input_fidelity !== undefined ? { input_fidelity: p.input_fidelity } : {}),
      ...(p.output_format !== undefined ? { output_format: p.output_format } : {}),
    };

    const taskId = await submitFalJob({
      fs,
      projectSlug: p.projectSlug,
      assetId: p.imgAssetId,
      assetDir: p.imgAssetDir,
      endpointId: "fal-ai/gpt-image-1.5/edit",
      input,
      taskType: "fal_gpt_image_1_5_edit",
      meta: { prompt: p.prompt, sourceImageIds: p.sourceImageIds },
    });

    return { success: true, taskId };
  });
}

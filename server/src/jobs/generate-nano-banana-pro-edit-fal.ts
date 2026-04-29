import type { ClipfirstFs } from "clipfirst-engine";
import { registerJobHandler } from "../queue.js";
import { uploadAssetToFal } from "./_fal-upload.js";
import { submitFalJob } from "./_fal-shared.js";
import type { ImageInput } from "../tools/_image-inputs.js";

type Payload = {
  type: "generate_nano_banana_pro_edit_fal";
  imgAssetId: string;
  imgAssetDir: string;
  projectSlug: string;
  prompt: string;
  imageInputs: ImageInput[];
  sourceImageIds: string[];
  num_images?: number;
  aspect_ratio?: string;
  resolution?: string;
  output_format?: string;
  seed?: number;
  enable_web_search?: boolean;
};

export function registerGenerateNanoBananaProEditFalJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_nano_banana_pro_edit_fal", async (payload) => {
    const p = payload as Payload;

    const image_urls = await Promise.all(
      p.imageInputs.map((i) =>
        "url" in i ? i.url : uploadAssetToFal(fs, i.assetId, i.filename, p.projectSlug),
      ),
    );

    const input: Record<string, unknown> = {
      prompt: p.prompt,
      image_urls,
      ...(p.num_images !== undefined ? { num_images: p.num_images } : {}),
      ...(p.aspect_ratio !== undefined ? { aspect_ratio: p.aspect_ratio } : {}),
      ...(p.resolution !== undefined ? { resolution: p.resolution } : {}),
      ...(p.output_format !== undefined ? { output_format: p.output_format } : {}),
      ...(p.seed !== undefined ? { seed: p.seed } : {}),
      ...(p.enable_web_search !== undefined ? { enable_web_search: p.enable_web_search } : {}),
    };

    const taskId = await submitFalJob({
      fs,
      projectSlug: p.projectSlug,
      assetId: p.imgAssetId,
      assetDir: p.imgAssetDir,
      endpointId: "fal-ai/nano-banana-pro/edit",
      input,
      taskType: "fal_nano_banana_pro_edit",
      meta: {
        prompt: p.prompt,
        sourceImageIds: p.sourceImageIds,
        ...(p.aspect_ratio !== undefined ? { aspectRatio: p.aspect_ratio } : {}),
        ...(p.resolution !== undefined ? { resolution: p.resolution } : {}),
        ...(p.output_format !== undefined ? { outputFormat: p.output_format } : {}),
      },
    });

    return { success: true, taskId };
  });
}

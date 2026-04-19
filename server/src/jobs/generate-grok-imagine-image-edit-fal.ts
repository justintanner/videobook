import type { ClipfirstFs } from "clipfirst-fs";
import { registerJobHandler } from "../queue.js";
import { uploadAssetToFal } from "./_fal-upload.js";
import { submitFalJob } from "./_fal-shared.js";

type ImageInput = { assetId: string; filename: string };

type Payload = {
  type: "generate_grok_imagine_image_edit_fal";
  imgAssetId: string;
  imgAssetDir: string;
  projectSlug: string;
  prompt: string;
  imageInputs: ImageInput[];
  sourceImageIds: string[];
  num_images?: number;
  resolution?: string;
  output_format?: string;
};

export function registerGenerateGrokImagineImageEditFalJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_grok_imagine_image_edit_fal", async (payload) => {
    const p = payload as Payload;

    const image_urls = await Promise.all(
      p.imageInputs.map((i) => uploadAssetToFal(fs, i.assetId, i.filename, p.projectSlug)),
    );

    const input: Record<string, unknown> = {
      prompt: p.prompt,
      image_urls,
      ...(p.num_images !== undefined ? { num_images: p.num_images } : {}),
      ...(p.resolution !== undefined ? { resolution: p.resolution } : {}),
      ...(p.output_format !== undefined ? { output_format: p.output_format } : {}),
    };

    const taskId = await submitFalJob({
      fs,
      projectSlug: p.projectSlug,
      assetId: p.imgAssetId,
      assetDir: p.imgAssetDir,
      endpointId: "xai/grok-imagine-image/edit",
      input,
      taskType: "fal_grok_imagine_image_edit",
      meta: {
        prompt: p.prompt,
        sourceImageId: p.sourceImageIds[0],
        sourceImageIds: p.sourceImageIds,
      },
    });

    return { success: true, taskId };
  });
}

import type { VideocityFs } from "videocity-engine";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { uploadAssetToFal } from "./_fal-upload.js";
import { submitFalJob } from "./_fal-shared.js";
import type { ImageInput } from "../tools/_image-inputs.js";

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

export function registerGenerateGrokImagineImageEditFalJob(fs: VideocityFs): void {
  registerJobHandler("generate_grok_imagine_image_edit_fal", async (payload, ctx) => {
    const p = payload as Payload;
    return withProviderHandoff(fs, p.projectSlug, p.imgAssetId, ctx, "generate", async (ownerId) => {
  
      const image_urls = await Promise.all(
        p.imageInputs.map((i) =>
          "url" in i ? i.url : uploadAssetToFal(fs, i.assetId, i.filename, p.projectSlug),
        ),
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
        expectedOwnerId: ownerId,
      });
  
      return { taskId, result: { success: true, taskId } };    });
  });
}

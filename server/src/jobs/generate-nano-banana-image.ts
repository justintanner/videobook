import type { ClipfirstFs } from "clipfirst-fs";
import { kie, submitMediaJob } from "@apicity/kie";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { writePendingTask } from "./pending-task.js";
import { buildNanoBananaImagePayload } from "../payload-builders.js";
import type { ImageInput } from "../tools/_image-inputs.js";

type GenerateNanoBananaImagePayload = {
  type: "generate_nano_banana_image";
  prompt: string;
  imageInputs: ImageInput[];
  imgAssetId: string;
  imgAssetDir: string;
  sourceImageIds: string[];
  projectSlug: string;
  aspectRatio?: string;
  resolution?: string;
  outputFormat?: string;
};

export function registerGenerateNanoBananaImageJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_nano_banana_image", async (payload) => {
    const {
      prompt, imageInputs, imgAssetId, imgAssetDir,
      sourceImageIds, projectSlug, aspectRatio, resolution, outputFormat,
    } = payload as GenerateNanoBananaImagePayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });

    const uploadedUrls: string[] = [];
    for (const input of imageInputs) {
      uploadedUrls.push(
        "url" in input
          ? input.url
          : await uploadAssetToKie(fs, input.assetId, input.filename, projectSlug),
      );
    }

    const request = buildNanoBananaImagePayload(
      { prompt, aspect_ratio: aspectRatio, resolution, output_format: outputFormat },
      uploadedUrls,
    );
    await fs.writeMetadata(imgAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
    await writePendingTask(fs, imgAssetId, projectSlug, {
      taskId,
      taskType: "nano_banana_image",
      assetId: imgAssetId,
      assetDir: imgAssetDir,
      projectSlug,
      createdAt: new Date().toISOString(),
      meta: {
        sourceImageIds,
        prompt,
        ...(aspectRatio !== undefined ? { aspectRatio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(outputFormat !== undefined ? { outputFormat } : {}),
      },
    });

    return { success: true, taskId };
  });
}

import type { ClipfirstFs } from "clipfirst-fs";
import { kie, submitMediaJob } from "@apicity/kie";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { writePendingTask } from "./pending-task.js";
import { buildQwen2ImageEditPayload } from "../payload-builders.js";
import type { ImageInput } from "../tools/_image-inputs.js";

type GenerateQwen2ImageEditPayload = {
  type: "generate_qwen2_image_edit";
  prompt: string;
  imageInputs: ImageInput[];
  imgAssetId: string;
  imgAssetDir: string;
  sourceImageIds: string[];
  projectSlug: string;
  imageSize?: string;
  outputFormat?: "png" | "jpeg";
  seed?: number;
};

export function registerGenerateQwen2ImageEditJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_qwen2_image_edit", async (payload) => {
    const {
      prompt, imageInputs, imgAssetId, imgAssetDir,
      sourceImageIds, projectSlug, imageSize, outputFormat, seed,
    } = payload as GenerateQwen2ImageEditPayload;

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

    const request = buildQwen2ImageEditPayload(
      { prompt, image_size: imageSize, output_format: outputFormat, seed },
      uploadedUrls,
    );
    await fs.writeMetadata(imgAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
    await writePendingTask(fs, imgAssetId, projectSlug, {
      taskId,
      taskType: "qwen2_image_edit",
      assetId: imgAssetId,
      assetDir: imgAssetDir,
      projectSlug,
      createdAt: new Date().toISOString(),
      meta: {
        sourceImageIds,
        prompt,
        ...(imageSize !== undefined ? { imageSize } : {}),
        ...(outputFormat !== undefined ? { outputFormat } : {}),
        ...(seed !== undefined ? { seed } : {}),
      },
    });

    return { success: true, taskId };
  });
}

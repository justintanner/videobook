import type { ClipfirstFs } from "clipfirst-fs";
import { kie, uploadFile, submitMediaJob } from "@nakedapi/kie";
import { registerJobHandler } from "../queue.js";
import { writePendingTask } from "./pending-task.js";
import { buildQwen2ImageEditPayload } from "../payload-builders.js";

type GenerateQwen2ImageEditPayload = {
  type: "generate_qwen2_image_edit";
  prompt: string;
  imageFilename: string;
  imgAssetId: string;
  imgAssetDir: string;
  sourceImageId: string;
  projectSlug: string;
  imageSize?: string;
  outputFormat?: "png" | "jpeg";
  seed?: number;
};

export function registerGenerateQwen2ImageEditJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_qwen2_image_edit", async (payload) => {
    const {
      prompt, imageFilename, imgAssetId, imgAssetDir,
      sourceImageId, projectSlug, imageSize, outputFormat, seed,
    } = payload as GenerateQwen2ImageEditPayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });

    const readResult = await fs.readFile(sourceImageId, imageFilename, projectSlug);
    if (!readResult.ok) throw new Error(readResult.error.message);
    const blob = new Blob([new Uint8Array(readResult.value)]);
    const uploadedUrl = await uploadFile(provider, blob, imageFilename);

    const request = buildQwen2ImageEditPayload(
      { prompt, image_size: imageSize, output_format: outputFormat, seed },
      [uploadedUrl],
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
        sourceImageId,
        prompt,
        ...(imageSize !== undefined ? { imageSize } : {}),
        ...(outputFormat !== undefined ? { outputFormat } : {}),
        ...(seed !== undefined ? { seed } : {}),
      },
    });

    return { success: true, taskId };
  });
}

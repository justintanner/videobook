import { readFile } from "node:fs/promises";
import { kie } from "@nakedapi/kie";
import { registerJobHandler } from "../queue.js";
import { writePendingTask } from "./pending-task.js";

type GenerateNanoBananaImagePayload = {
  type: "generate_nano_banana_image";
  prompt: string;
  imageInputs: Array<{ path: string; filename: string }>;
  imgAssetId: string;
  imgAssetDir: string;
  sourceImageIds: string[];
  projectSlug: string;
  aspectRatio?: string;
  resolution?: string;
  outputFormat?: string;
};

export function registerGenerateNanoBananaImageJob(): void {
  registerJobHandler("generate_nano_banana_image", async (payload) => {
    const {
      prompt, imageInputs, imgAssetId, imgAssetDir,
      sourceImageIds, projectSlug, aspectRatio, resolution, outputFormat,
    } = payload as GenerateNanoBananaImagePayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });

    const uploadedUrls: string[] = [];
    for (const { path, filename } of imageInputs) {
      const imageBuffer = await readFile(path);
      const blob = new Blob([imageBuffer]);
      const { downloadUrl } = await provider.uploadMedia({ file: blob, filename });
      uploadedUrls.push(downloadUrl);
    }

    const { taskId } = await provider.createTask({
      model: "nano-banana-pro",
      input: {
        prompt,
        ...(uploadedUrls.length > 0 ? { image_input: uploadedUrls } : {}),
        ...(aspectRatio !== undefined ? { aspect_ratio: aspectRatio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(outputFormat !== undefined ? { output_format: outputFormat } : {}),
      },
    });

    await writePendingTask(imgAssetDir, {
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

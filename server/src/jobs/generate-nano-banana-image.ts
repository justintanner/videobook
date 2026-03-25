import type { ClipfirstFs } from "clipfirst-fs";
import { kie } from "@nakedapi/kie";
import { registerJobHandler } from "../queue.js";
import { writePendingTask } from "./pending-task.js";
import { buildNanoBananaImagePayload } from "../payload-builders.js";

type GenerateNanoBananaImagePayload = {
  type: "generate_nano_banana_image";
  prompt: string;
  imageInputs: Array<{ assetId: string; filename: string }>;
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
    for (const { assetId: srcAssetId, filename } of imageInputs) {
      const readResult = await fs.readFile(srcAssetId, filename, projectSlug);
      if (!readResult.ok) throw new Error(readResult.error.message);
      const blob = new Blob([new Uint8Array(readResult.value)]);
      const upload = await provider.api.fileStreamUpload({ file: blob, filename });
      if (!upload.data?.downloadUrl) throw new Error("KIE upload failed: no download URL in response");
      uploadedUrls.push(upload.data.downloadUrl);
    }

    const request = buildNanoBananaImagePayload(
      { prompt, aspect_ratio: aspectRatio, resolution, output_format: outputFormat },
      uploadedUrls,
    );
    await fs.writeMetadata(imgAssetId, "generation-payload", request, projectSlug);
    const taskResult = await provider.api.v1.jobs.createTask(request);
    if (!taskResult.data?.taskId) throw new Error("KIE createTask failed: no taskId in response");
    const taskId = taskResult.data.taskId;

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

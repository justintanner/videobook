import type { ClipfirstFs } from "clipfirst-fs";
import { kie } from "@nakedapi/kie";
import { registerJobHandler } from "../queue.js";
import { writePendingTask } from "./pending-task.js";
import { buildGptImagePayload } from "../payload-builders.js";

type GenerateGptImagePayload = {
  type: "generate_gpt_image";
  prompt: string;
  imageInputs: Array<{ assetId: string; filename: string }>;
  imgAssetId: string;
  imgAssetDir: string;
  sourceImageIds: string[];
  projectSlug: string;
  aspectRatio?: string;
  quality?: string;
};

export function registerGenerateGptImageJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_gpt_image", async (payload) => {
    const {
      prompt, imageInputs, imgAssetId, imgAssetDir,
      sourceImageIds, projectSlug, aspectRatio, quality,
    } = payload as GenerateGptImagePayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });

    const uploadedUrls: string[] = [];
    for (const { assetId: srcAssetId, filename } of imageInputs) {
      const readResult = await fs.readFile(srcAssetId, filename, projectSlug);
      if (!readResult.ok) throw new Error(readResult.error.message);
      const blob = new Blob([new Uint8Array(readResult.value)]);
      const upload = await provider.post.api.fileStreamUpload({ file: blob, filename });
      if (!upload.data?.downloadUrl) throw new Error("KIE upload failed: no download URL in response");
      uploadedUrls.push(upload.data.downloadUrl);
    }

    const request = buildGptImagePayload(
      { prompt, aspect_ratio: aspectRatio, quality },
      uploadedUrls,
    );
    const taskResult = await provider.post.api.v1.jobs.createTask(request);
    if (!taskResult.data?.taskId) {
      const msg = (taskResult as Record<string, unknown>).msg as string | undefined;
      throw new Error(`KIE createTask failed: ${msg ?? 'no taskId in response'}`);
    }
    const taskId = taskResult.data.taskId;

    await fs.writeMetadata(imgAssetId, "generation-payload", request, projectSlug);
    await writePendingTask(fs, imgAssetId, projectSlug, {
      taskId,
      taskType: "gpt_image",
      assetId: imgAssetId,
      assetDir: imgAssetDir,
      projectSlug,
      createdAt: new Date().toISOString(),
      meta: {
        sourceImageIds,
        prompt,
        ...(aspectRatio !== undefined ? { aspectRatio } : {}),
        ...(quality !== undefined ? { quality } : {}),
      },
    });

    return { success: true, taskId };
  });
}

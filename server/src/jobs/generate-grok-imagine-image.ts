import type { ClipfirstFs } from "clipfirst-fs";
import { kie } from "@nakedapi/kie";
import type { GrokImageToImageRequest } from "@nakedapi/kie";
import { xai } from "@nakedapi/xai";
import { registerJobHandler } from "../queue.js";
import { writePendingTask, deletePendingTask } from "./pending-task.js";
import { buildGrokImagineImagePayload } from "../payload-builders.js";

type GenerateGrokImagineImagePayload = {
  type: "generate_grok_imagine_image";
  imagePath: string;
  imageFilename: string;
  imgAssetId: string;
  imgAssetDir: string;
  sourceImageId: string;
  projectSlug: string;
  prompt?: string;
  aspectRatio?: string;
  _provider?: string;
};

export function registerGenerateGrokImagineImageJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_grok_imagine_image", async (payload) => {
    const {
      imageFilename, imgAssetId, imgAssetDir,
      sourceImageId, projectSlug, prompt, aspectRatio, _provider,
    } = payload as GenerateGrokImagineImagePayload;

    const isXai = _provider !== undefined && _provider.startsWith("xai");

    const readResult = await fs.readFile(sourceImageId, imageFilename, projectSlug);
    if (!readResult.ok) throw new Error(readResult.error.message);
    const imageBytes = new Uint8Array(readResult.value);

    if (isXai) {
      // xAI path — synchronous image generation
      const apiKey = process.env.XAI_API_KEY;
      if (!apiKey) throw new Error("XAI_API_KEY environment variable is not set");

      const provider = xai({ apiKey, timeout: 120_000 });

      // Convert to base64 data URL for the image reference
      const ext = imageFilename.split(".").pop()?.toLowerCase() ?? "png";
      const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
      const b64 = Buffer.from(imageBytes).toString("base64");
      const dataUrl = `data:${mime};base64,${b64}`;

      const request = {
        prompt: prompt ?? "",
        image: { url: dataUrl, type: "image_url" as const },
        ...(aspectRatio !== undefined ? { aspect_ratio: aspectRatio } : {}),
      };
      const result = await provider.post.v1.images.edits(request);

      const imageUrl = result.data[0]?.url;
      if (!imageUrl) throw new Error("xAI returned no image URL");

      // Download the result image
      const resp = await fetch(imageUrl);
      if (!resp.ok) throw new Error(`Failed to download result image: ${resp.status}`);
      const resultBuffer = Buffer.from(await resp.arrayBuffer());

      // Write payload and result to asset
      await fs.writeMetadata(imgAssetId, "generation-payload", request, projectSlug);
      await fs.writeFile(imgAssetId, "original.png", resultBuffer, projectSlug);

      // Clear queued pending task written by tool handler
      await deletePendingTask(fs, imgAssetId, projectSlug);

      return { success: true, provider: "xai" };
    }

    // Kie path — async task-based generation
    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });
    const blob = new Blob([imageBytes]);

    const upload = await provider.post.api.fileStreamUpload({
      file: blob,
      filename: imageFilename,
    });
    if (!upload.data?.downloadUrl) throw new Error("KIE upload failed: no download URL in response");
    const downloadUrl = upload.data.downloadUrl;

    const request = buildGrokImagineImagePayload({ prompt, aspect_ratio: aspectRatio as GrokImageToImageRequest["input"]["aspect_ratio"] }, [downloadUrl]);
    const taskResult = await provider.post.api.v1.jobs.createTask(request);
    if (!taskResult.data?.taskId) {
      const msg = (taskResult as Record<string, unknown>).msg as string | undefined;
      throw new Error(`KIE createTask failed: ${msg ?? 'no taskId in response'}`);
    }
    const taskId = taskResult.data.taskId;

    await fs.writeMetadata(imgAssetId, "generation-payload", request, projectSlug);
    await writePendingTask(fs, imgAssetId, projectSlug, {
      taskId,
      taskType: "grok_imagine_image",
      assetId: imgAssetId,
      assetDir: imgAssetDir,
      projectSlug,
      createdAt: new Date().toISOString(),
      meta: {
        sourceImageId,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(aspectRatio !== undefined ? { aspectRatio } : {}),
      },
    });

    return { success: true, taskId };
  });
}

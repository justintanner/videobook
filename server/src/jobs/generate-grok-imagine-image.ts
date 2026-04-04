import type { ClipfirstFs } from "clipfirst-fs";
import { kie, uploadFile, submitMediaJob } from "@nakedapi/kie";
import type { GrokImageToImageRequest } from "@nakedapi/kie";
import { xai } from "@nakedapi/xai";
import { queue, registerJobHandler } from "../queue.js";
import { writePendingTask, deletePendingTask } from "./pending-task.js";
import { buildGrokImagineImagePayload, buildXaiGrokImagineImagePayload } from "../payload-builders.js";

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

      const request = buildXaiGrokImagineImagePayload(
        { prompt, aspect_ratio: aspectRatio },
        [dataUrl],
      );
      await fs.writeMetadata(imgAssetId, "generation-payload", request, projectSlug);
      const result = await provider.post.v1.images.edits(request);

      const imageUrl = result.data[0]?.url;
      if (!imageUrl) throw new Error("xAI returned no image URL");

      // Download the result image
      const resp = await fetch(imageUrl);
      if (!resp.ok) throw new Error(`Failed to download result image: ${resp.status}`);
      const resultBuffer = Buffer.from(await resp.arrayBuffer());
      await fs.writeFile(imgAssetId, "original.png", resultBuffer, projectSlug);

      // Enqueue post-processing so .original.json and derived crops are created
      const provenance = {
        source_asset: sourceImageId,
        model: "grok-imagine/image-to-image",
        ...(prompt !== undefined ? { prompt } : {}),
        generated_at: new Date().toISOString(),
      };
      await queue.enqueue(`process-image-${imgAssetId}-${Date.now()}`, {
        type: "process_image",
        assetId: imgAssetId,
        projectSlug,
        extension: ".png",
        provenance,
      } as unknown as Record<string, unknown>);

      // Clear queued pending task written by tool handler
      await deletePendingTask(fs, imgAssetId, projectSlug);

      return { success: true, provider: "xai" };
    }

    // Kie path — async task-based generation
    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });
    const blob = new Blob([imageBytes]);

    const downloadUrl = await uploadFile(provider, blob, imageFilename);

    const request = buildGrokImagineImagePayload({ prompt, aspect_ratio: aspectRatio as GrokImageToImageRequest["input"]["aspect_ratio"] }, [downloadUrl]);
    await fs.writeMetadata(imgAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
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

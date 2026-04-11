import type { ClipfirstFs } from "clipfirst-fs";
import { kie, submitMediaJob } from "@apicity/kie";
import { uploadAssetFile } from "../kie-upload.js";
import type { GrokImageToImageRequest } from "@apicity/kie";
import { xai } from "@apicity/xai";
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

    if (isXai) {
      // xAI path — synchronous image generation
      const apiKey = process.env.XAI_API_KEY;
      if (!apiKey) throw new Error("XAI_API_KEY environment variable is not set");

      const provider = xai({ apiKey, timeout: 120_000 });

      // Upload image via kie for a publicly accessible URL
      const kieKey = process.env.KIE_API_KEY;
      if (!kieKey) throw new Error("KIE_API_KEY environment variable is required for image upload");
      const kieProvider = kie({ apiKey: kieKey, timeout: 60_000 });
      const imageUrl = await uploadAssetFile(kieProvider, fs, sourceImageId, imageFilename, projectSlug);

      const request = buildXaiGrokImagineImagePayload(
        { prompt, aspect_ratio: aspectRatio },
        [imageUrl],
      );
      await fs.writeMetadata(imgAssetId, "generation-payload", request, projectSlug);
      const result = await provider.post.v1.images.edits(request);

      const resultImageUrl = result.data[0]?.url;
      if (!resultImageUrl) throw new Error("xAI returned no image URL");

      // Download the result image
      const resp = await fetch(resultImageUrl);
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

    const downloadUrl = await uploadAssetFile(provider, fs, sourceImageId, imageFilename, projectSlug);

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

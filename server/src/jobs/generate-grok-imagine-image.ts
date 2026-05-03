import type { ClipfirstFs } from "clipfirst-engine";
import { kie, submitMediaJob } from "@apicity/kie";
import { uploadAssetFile } from "../upload.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import type { GrokImageToImageRequest } from "@apicity/kie";
import { xai } from "@apicity/xai";
import { queue, registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { downloadUrlIntoAsset } from "./_download-into-asset.js";
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
  registerJobHandler("generate_grok_imagine_image", async (payload, ctx) => {
    const {
      imageFilename, imgAssetId, imgAssetDir,
      sourceImageId, projectSlug, prompt, aspectRatio, _provider,
    } = payload as GenerateGrokImagineImagePayload;

    const isXai = _provider !== undefined && _provider.startsWith("xai");

    if (isXai) {
      // xAI path — synchronous image generation
      const apiKey = requireApiKey("XAI_API_KEY");

      const provider = xai({ apiKey, timeout: 120_000 });

      const imageUrl = await uploadAssetFile(fs, sourceImageId, imageFilename, projectSlug);

      const request = buildXaiGrokImagineImagePayload(
        { prompt, aspect_ratio: aspectRatio },
        [imageUrl],
      );
      await fs.writeMetadata(imgAssetId, "generation-payload", request, projectSlug);
      const result = await provider.post.v1.images.edits(request);

      const resultImageUrl = result.data[0]?.url;
      if (!resultImageUrl) throw new Error("xAI returned no image URL");

      await downloadUrlIntoAsset(fs, resultImageUrl, imgAssetId, "original.png", projectSlug, { kind: "result image" });

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
      await fs.pendingTasks.delete(projectSlug, imgAssetId);

      return { success: true, provider: "xai" };
    }

    // Kie path — async task-based generation
    const apiKey = requireApiKey("KIE_API_KEY");

    const provider = kie({ apiKey, timeout: 60_000 });

    const downloadUrl = await uploadAssetToKie(fs, sourceImageId, imageFilename, projectSlug);

    const request = buildGrokImagineImagePayload({ prompt, aspect_ratio: aspectRatio as GrokImageToImageRequest["input"]["aspect_ratio"] }, [downloadUrl]);
    await fs.writeMetadata(imgAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
    {
      const _ptResult = await fs.pendingTasks.write(projectSlug, {
        taskId,
        taskType: "grok_imagine_image",
        assetId: imgAssetId,
        assetDir: imgAssetDir,
        meta: {
          sourceImageId,
          ...(prompt !== undefined ? { prompt } : {}),
          ...(aspectRatio !== undefined ? { aspectRatio } : {}),
        },
    }, ctx.getOwnerId());
      if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${imgAssetId}: ${_ptResult.error.message}`);
      if (_ptResult.value === null) throw new Error(`Lost local lease while writing pending-task`);
    }
    ctx.setLease({ kind: "task", taskId });

    return { success: true, taskId };
  });
}

import type { Engine } from "videobook-engine";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetFile } from "../upload.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import type { XaiImageEditRequest, XaiImageResponse } from "@apicity/xai";
import { queue, registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { downloadUrlIntoAsset } from "./_download-into-asset.js";
import { buildGrokImagineImagePayload, buildXaiGrokImagineImagePayload } from "../payload-builders.js";
import { callXaiPaid, createXaiPaygatedProvider, XAI_IMAGE_EDITS_DOT_PATH } from "./xai-paygate.js";

type GenerateGrokImagineImagePayload = {
  type: "generate_grok_imagine_image";
  imagePath: string;
  imageFilename: string;
  imgAssetId: string;
  imgAssetDir: string;
  sourceImageId: string;
  projectSlug: string;
  prompt?: string;
  _provider?: string;
};

export function registerGenerateGrokImagineImageJob(fs: Engine): void {
  registerJobHandler("generate_grok_imagine_image", async (payload, ctx) => {
    const {
      imageFilename, imgAssetId, imgAssetDir,
      sourceImageId, projectSlug, prompt, _provider,
    } = payload as GenerateGrokImagineImagePayload;

    const isXai = _provider !== undefined && _provider.startsWith("xai");

    if (isXai) {
      // xAI path — synchronous image generation
      const apiKey = requireApiKey("XAI_API_KEY");

      const provider = createXaiPaygatedProvider(apiKey, 120_000);

      const imageUrl = await uploadAssetFile(fs, sourceImageId, imageFilename, projectSlug);

      const request = buildXaiGrokImagineImagePayload(
        { prompt },
        [imageUrl],
      );
      await fs.metadata.artifacts.write(imgAssetId, "generation-payload", request, projectSlug);
      const result = await callXaiPaid<XaiImageEditRequest, XaiImageResponse>(
        provider.post.v1.images.edits,
        XAI_IMAGE_EDITS_DOT_PATH,
        request,
      );

      const resultImageUrl = result.data[0]?.url;
      if (!resultImageUrl) throw new Error("xAI returned no image URL");

      await downloadUrlIntoAsset(fs, resultImageUrl, imgAssetId, "original.png", projectSlug, { kind: "result image" });

      // Enqueue post-processing so metadata and derived crops are created
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
      await fs.jobs.pending.delete(projectSlug, imgAssetId);

      return { success: true, provider: "xai" };
    }

    // Kie path — async task-based generation
    requireApiKey("KIE_API_KEY");

    const downloadUrl = await uploadAssetToKie(fs, sourceImageId, imageFilename, projectSlug);

    const request = buildGrokImagineImagePayload({ prompt }, [downloadUrl]);
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "grok_imagine_image",
      assetId: imgAssetId,
      assetDir: imgAssetDir,
      projectSlug,
      meta: {
        sourceImageId,
        ...(prompt !== undefined ? { prompt } : {}),
      },
    });

    return { success: true, taskId };
  });
}

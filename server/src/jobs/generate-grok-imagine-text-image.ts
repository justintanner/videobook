import type { Engine } from "videobook-engine";
import { submitKieTask } from "./kie-paygate.js";
import type { XaiImageGenerateRequest, XaiImageResponse } from "@apicity/xai";
import { queue, registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { downloadUrlIntoAsset } from "./_download-into-asset.js";
import { buildGrokImagineTextPayload } from "../payload-builders.js";
import { callXaiPaid, createXaiPaygatedProvider, XAI_IMAGE_GENERATIONS_DOT_PATH } from "./xai-paygate.js";
import type { GrokTextToImageRequest } from "@apicity/kie";

type GenerateGrokImagineTextImagePayload = {
  type: "generate_grok_imagine_text_image";
  prompt: string;
  imgAssetId: string;
  imgAssetDir: string;
  bookId: string;
  aspectRatio?: GrokTextToImageRequest["input"]["aspect_ratio"];
  enablePro?: boolean;
  nsfwChecker?: boolean;
  _provider?: string;
};

export function registerGenerateGrokImagineTextImageJob(fs: Engine): void {
  registerJobHandler("generate_grok_imagine_text_image", async (payload, ctx) => {
    const {
      prompt, imgAssetId, imgAssetDir, bookId, aspectRatio, enablePro, nsfwChecker, _provider,
    } = payload as GenerateGrokImagineTextImagePayload;

    const isXai = _provider !== undefined && _provider.startsWith("xai");

    if (isXai) {
      // xAI path — synchronous image generation
      const apiKey = requireApiKey("XAI_API_KEY");

      const provider = createXaiPaygatedProvider(apiKey, 120_000);

      const request: XaiImageGenerateRequest = {
        prompt,
        n: 1,
        response_format: "url",
        ...(aspectRatio !== undefined ? { aspect_ratio: aspectRatio as XaiImageGenerateRequest["aspect_ratio"] } : {}),
      };
      await fs.metadata.artifacts.write(imgAssetId, "generation-payload", request);
      const result = await callXaiPaid<XaiImageGenerateRequest, XaiImageResponse>(
        provider.post.v1.images.generations,
        XAI_IMAGE_GENERATIONS_DOT_PATH,
        request,
      );

      const imageUrl = result.data[0]?.url;
      if (!imageUrl) throw new Error("xAI returned no image URL");

      await downloadUrlIntoAsset(fs, imageUrl, imgAssetId, "original.png", bookId, { kind: "result image" });

      // Enqueue post-processing so metadata and derived crops are created
      const provenance = {
        model: "grok-imagine/text-to-image",
        prompt,
        ...(aspectRatio !== undefined ? { aspect_ratio: aspectRatio } : {}),
        generated_at: new Date().toISOString(),
      };
      await queue.enqueue(`process-image-${imgAssetId}-${Date.now()}`, {
        type: "process_image",
        assetId: imgAssetId,
        bookId,
        extension: ".png",
        provenance,
      } as unknown as Record<string, unknown>);

      await fs.jobs.pending.delete(imgAssetId);

      return { success: true, provider: "xai" };
    }

    // Kie path — async task-based generation
    requireApiKey("KIE_API_KEY");

    const request = buildGrokImagineTextPayload({
      prompt,
      aspect_ratio: aspectRatio,
      ...(enablePro !== undefined ? { enable_pro: enablePro } : {}),
      ...(nsfwChecker !== undefined ? { nsfw_checker: nsfwChecker } : {}),
    });
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "grok_imagine_text",
      assetId: imgAssetId,
      assetDir: imgAssetDir,
      bookId,
      meta: { prompt, ...(aspectRatio !== undefined ? { aspectRatio } : {}) },
    });

    return { success: true, taskId };
  });
}

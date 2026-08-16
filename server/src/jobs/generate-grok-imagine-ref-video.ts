import type { Engine } from "videobook-engine";
import type { XaiVideoAsyncResponse, XaiVideoGenerateRequest } from "@apicity/xai";
import { uploadAssetFile } from "../upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildXaiGrokImagineRefVideoPayload } from "../payload-builders.js";
import { transformProviderPrompt } from "../provider-prompt-transform.js";
import { callXaiPaid, createXaiPaygatedProvider, XAI_VIDEO_GENERATIONS_DOT_PATH } from "./xai-paygate.js";

type RefImageInput = {
  assetId: string;
  filename: string;
};

type GenerateGrokImagineRefVideoPayload = {
  type: "generate_grok_imagine_ref_video";
  prompt: string;
  vidAssetId: string;
  vidAssetDir: string;
  bookId: string;
  refImages: RefImageInput[];
  duration?: string;
  resolution?: XaiVideoGenerateRequest["resolution"];
  aspectRatio?: XaiVideoGenerateRequest["aspect_ratio"];
};

export function registerGenerateGrokImagineRefVideoJob(fs: Engine): void {
  registerJobHandler("generate_grok_imagine_ref_video", async (payload, ctx) => {
    const {
      prompt, vidAssetId,
      refImages, duration, resolution, aspectRatio,
    } = payload as GenerateGrokImagineRefVideoPayload;

    const apiKey = requireApiKey("XAI_API_KEY");

    const imageUrls: string[] = [];
    for (const ref of refImages) {
      imageUrls.push(await uploadAssetFile(fs, ref.assetId, ref.filename));
    }

    const provider = createXaiPaygatedProvider(apiKey, 120_000);

    const normalizedPrompt = transformProviderPrompt(
      "generate_xai_grok_imagine_video",
      {
        prompt,
        image_refs: refImages.map((image) => image.assetId),
      },
      "xai",
    ) ?? "";
    const request = buildXaiGrokImagineRefVideoPayload(
      { prompt: normalizedPrompt, duration, resolution, aspect_ratio: aspectRatio },
      imageUrls,
    );

    await fs.metadata.artifacts.write(vidAssetId, "generation-payload", request);
    const { request_id } = await callXaiPaid<XaiVideoGenerateRequest, XaiVideoAsyncResponse>(
      provider.post.v1.videos.generations,
      XAI_VIDEO_GENERATIONS_DOT_PATH,
      request,
    );
    // Write pending task for async polling (reconcile-project-work.ts picks up xai_ prefixed tasks)
    {
      const _ptResult = await fs.jobs.pending.write({
        taskId: request_id,
        taskType: "xai_grok_imagine_ref_video",
        artifactId: vidAssetId,
        meta: {
          prompt,
          refCount: refImages.length,
          ...(duration !== undefined ? { duration } : {}),
          ...(resolution !== undefined ? { resolution } : {}),
          ...(aspectRatio !== undefined ? { aspectRatio } : {}),
        },
      }, ctx.getOwnerId());
      if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${vidAssetId}: ${_ptResult.error.message}`);
      if (_ptResult.value === null) throw new Error(`Lost local lease while writing pending-task`);
    }
    ctx.setLease({ kind: "task", taskId: request_id });

    return { success: true, requestId: request_id, provider: "xai" };
  });
}

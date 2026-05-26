import type { ClipfirstFs } from "vc-engine";
import { kie, submitMediaJob } from "@apicity/kie";
import { xai } from "@apicity/xai";
import type { XaiImageGenerateRequest } from "@apicity/xai";
import { queue, registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { downloadUrlIntoAsset } from "./_download-into-asset.js";
import { buildGrokImagineTextPayload } from "../payload-builders.js";

type GenerateGrokImagineTextImagePayload = {
  type: "generate_grok_imagine_text_image";
  prompt: string;
  imgAssetId: string;
  imgAssetDir: string;
  projectSlug: string;
  aspectRatio?: string;
  enablePro?: boolean;
  nsfwChecker?: boolean;
  _provider?: string;
};

export function registerGenerateGrokImagineTextImageJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_grok_imagine_text_image", async (payload, ctx) => {
    const {
      prompt, imgAssetId, imgAssetDir, projectSlug, aspectRatio, enablePro, nsfwChecker, _provider,
    } = payload as GenerateGrokImagineTextImagePayload;

    const isXai = _provider !== undefined && _provider.startsWith("xai");

    if (isXai) {
      // xAI path — synchronous image generation
      const apiKey = requireApiKey("XAI_API_KEY");

      const provider = xai({ apiKey, timeout: 120_000 });

      const request: XaiImageGenerateRequest = {
        prompt,
        n: 1,
        response_format: "url",
        ...(aspectRatio !== undefined ? { aspect_ratio: aspectRatio } : {}),
      };
      await fs.writeMetadata(imgAssetId, "generation-payload", request, projectSlug);
      const result = await provider.post.v1.images.generations(request);

      const imageUrl = result.data[0]?.url;
      if (!imageUrl) throw new Error("xAI returned no image URL");

      await downloadUrlIntoAsset(fs, imageUrl, imgAssetId, "original.png", projectSlug, { kind: "result image" });

      // Enqueue post-processing so .original.json and derived crops are created
      const provenance = {
        model: "grok-imagine/text-to-image",
        prompt,
        ...(aspectRatio !== undefined ? { aspect_ratio: aspectRatio } : {}),
        generated_at: new Date().toISOString(),
      };
      await queue.enqueue(`process-image-${imgAssetId}-${Date.now()}`, {
        type: "process_image",
        assetId: imgAssetId,
        projectSlug,
        extension: ".png",
        provenance,
      } as unknown as Record<string, unknown>);

      await fs.pendingTasks.delete(projectSlug, imgAssetId);

      return { success: true, provider: "xai" };
    }

    // Kie path — async task-based generation
    const apiKey = requireApiKey("KIE_API_KEY");

    const provider = kie({ apiKey, timeout: 60_000 });

    const request = buildGrokImagineTextPayload({
      prompt,
      aspect_ratio: aspectRatio,
      ...(enablePro !== undefined ? { enable_pro: enablePro } : {}),
      ...(nsfwChecker !== undefined ? { nsfw_checker: nsfwChecker } : {}),
    });
    await fs.writeMetadata(imgAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
    {
      const _ptResult = await fs.pendingTasks.write(projectSlug, {
        taskId,
        taskType: "grok_imagine_text",
        assetId: imgAssetId,
        assetDir: imgAssetDir,
        meta: { prompt, ...(aspectRatio !== undefined ? { aspectRatio } : {}) },
    }, ctx.getOwnerId());
      if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${imgAssetId}: ${_ptResult.error.message}`);
      if (_ptResult.value === null) throw new Error(`Lost local lease while writing pending-task`);
    }
    ctx.setLease({ kind: "task", taskId });

    return { success: true, taskId };
  });
}

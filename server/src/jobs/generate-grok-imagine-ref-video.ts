import type { ClipfirstFs } from "clipfirst-engine";
import { uploadAssetFile } from "../upload.js";
import { xai } from "@apicity/xai";
import { registerJobHandler } from "../queue.js";
import { buildXaiGrokImagineRefVideoPayload } from "../payload-builders.js";

type RefImageInput = {
  assetId: string;
  filename: string;
};

type GenerateGrokImagineRefVideoPayload = {
  type: "generate_grok_imagine_ref_video";
  prompt: string;
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  refImages: RefImageInput[];
  duration?: string;
  resolution?: string;
  aspectRatio?: string;
};

export function registerGenerateGrokImagineRefVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_grok_imagine_ref_video", async (payload, ctx) => {
    const {
      prompt, vidAssetId, vidAssetDir, projectSlug,
      refImages, duration, resolution, aspectRatio,
    } = payload as GenerateGrokImagineRefVideoPayload;

    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) throw new Error("XAI_API_KEY environment variable is not set");

    const imageUrls: string[] = [];
    for (const ref of refImages) {
      imageUrls.push(await uploadAssetFile(fs, ref.assetId, ref.filename, projectSlug));
    }

    const provider = xai({ apiKey, timeout: 120_000 });

    const request = buildXaiGrokImagineRefVideoPayload(
      { prompt, duration, resolution, aspect_ratio: aspectRatio },
      imageUrls,
    );

    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
    const { request_id } = await provider.post.v1.videos.generations(request);
    // Write pending task for async polling (sync.ts picks up xai_ prefixed tasks)
    {
      const _ptResult = await fs.pendingTasks.write(projectSlug, {
        taskId: request_id,
        taskType: "xai_grok_imagine_ref_video",
        assetId: vidAssetId,
        assetDir: vidAssetDir,
        meta: {
          prompt,
          refCount: refImages.length,
          ...(duration !== undefined ? { duration } : {}),
          ...(resolution !== undefined ? { resolution } : {}),
          ...(aspectRatio !== undefined ? { aspectRatio } : {}),
        },
    }, ctx.getOwnerId());
      if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${vidAssetId}: ${_ptResult.error.message}`);
    }
    ctx.setLease({ kind: "task", taskId: request_id });

    return { success: true, requestId: request_id, provider: "xai" };
  });
}

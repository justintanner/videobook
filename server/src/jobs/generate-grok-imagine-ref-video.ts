import type { ClipfirstFs } from "clipfirst-fs";
import { kie } from "@apicity/kie";
import { uploadAssetFile } from "../kie-upload.js";
import { xai } from "@apicity/xai";
import { registerJobHandler } from "../queue.js";
import { writePendingTask } from "./pending-task.js";
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
  registerJobHandler("generate_grok_imagine_ref_video", async (payload) => {
    const {
      prompt, vidAssetId, vidAssetDir, projectSlug,
      refImages, duration, resolution, aspectRatio,
    } = payload as GenerateGrokImagineRefVideoPayload;

    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) throw new Error("XAI_API_KEY environment variable is not set");

    // Upload reference images to get publicly accessible URLs
    const kieKey = process.env.KIE_API_KEY;
    if (!kieKey) throw new Error("KIE_API_KEY environment variable is required for image upload");
    const kieProvider = kie({ apiKey: kieKey, timeout: 60_000 });

    const imageUrls: string[] = [];
    for (const ref of refImages) {
      imageUrls.push(await uploadAssetFile(kieProvider, fs, ref.assetId, ref.filename, projectSlug));
    }

    const provider = xai({ apiKey, timeout: 120_000 });

    const request = buildXaiGrokImagineRefVideoPayload(
      { prompt, duration, resolution, aspect_ratio: aspectRatio },
      imageUrls,
    );

    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
    const { request_id } = await provider.post.v1.videos.generations(request);
    // Write pending task for async polling (sync.ts picks up xai_ prefixed tasks)
    await writePendingTask(fs, vidAssetId, projectSlug, {
      taskId: request_id,
      taskType: "xai_grok_imagine_ref_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
      createdAt: new Date().toISOString(),
      meta: {
        prompt,
        refCount: refImages.length,
        ...(duration !== undefined ? { duration } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(aspectRatio !== undefined ? { aspectRatio } : {}),
      },
    });

    return { success: true, requestId: request_id, provider: "xai" };
  });
}

import type { ClipfirstFs } from "clipfirst-fs";
import { kie, uploadFile } from "@nakedapi/kie";
import { xai } from "@nakedapi/xai";
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
    const imageUrls: string[] = [];
    for (const ref of refImages) {
      const readResult = await fs.readFile(ref.assetId, ref.filename, projectSlug);
      if (!readResult.ok) throw new Error(readResult.error.message);
      const imageBytes = new Uint8Array(readResult.value);

      // Upload via Kie API for a public URL (xAI needs URLs)
      const kieKey = process.env.KIE_API_KEY;
      if (kieKey) {
        const kieProvider = kie({ apiKey: kieKey, timeout: 60_000 });
        const blob = new Blob([imageBytes]);
        const imageUrl = await uploadFile(kieProvider, blob, ref.filename);
        imageUrls.push(imageUrl);
      } else {
        // Fallback: base64 data URL
        const ext = ref.filename.split(".").pop()?.toLowerCase() ?? "png";
        const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
        const b64 = Buffer.from(imageBytes).toString("base64");
        imageUrls.push(`data:${mime};base64,${b64}`);
      }
    }

    const provider = xai({ apiKey, timeout: 120_000 });

    const request = buildXaiGrokImagineRefVideoPayload(
      { prompt, duration, resolution, aspect_ratio: aspectRatio },
      imageUrls,
    );

    const { request_id } = await provider.post.v1.videos.generations(request);

    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
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

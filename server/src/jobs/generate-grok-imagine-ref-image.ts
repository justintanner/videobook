import type { ClipfirstFs } from "clipfirst-fs";
import { xai } from "@nakedapi/xai";
import { registerJobHandler } from "../queue.js";
import { deletePendingTask } from "./pending-task.js";

type RefImageInput = {
  assetId: string;
  filename: string;
};

type GenerateGrokImagineRefImagePayload = {
  type: "generate_grok_imagine_ref_image";
  prompt: string;
  imgAssetId: string;
  imgAssetDir: string;
  projectSlug: string;
  refImages: RefImageInput[];
  aspectRatio?: string;
};

export function registerGenerateGrokImagineRefImageJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_grok_imagine_ref_image", async (payload) => {
    const {
      prompt, imgAssetId, projectSlug, refImages, aspectRatio,
    } = payload as GenerateGrokImagineRefImagePayload;

    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) throw new Error("XAI_API_KEY environment variable is not set");

    const provider = xai({ apiKey, timeout: 120_000 });

    // Read and convert reference images to base64 data URLs
    const imageRefs: Array<{ url: string; type: "image_url" }> = [];
    for (const ref of refImages) {
      const readResult = await fs.readFile(ref.assetId, ref.filename, projectSlug);
      if (!readResult.ok) throw new Error(readResult.error.message);
      const bytes = new Uint8Array(readResult.value);
      const ext = ref.filename.split(".").pop()?.toLowerCase() ?? "png";
      const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
      const b64 = Buffer.from(bytes).toString("base64");
      imageRefs.push({ url: `data:${mime};base64,${b64}`, type: "image_url" as const });
    }

    // Build request — image/images fields depend on reference count
    const request: Record<string, unknown> = {
      prompt,
      ...(aspectRatio !== undefined ? { aspect_ratio: aspectRatio } : {}),
    };

    if (imageRefs.length === 1) {
      request.image = imageRefs[0];
    } else if (imageRefs.length > 1) {
      request.images = imageRefs;
    }

    await fs.writeMetadata(imgAssetId, "generation-payload", request, projectSlug);
    const result = await provider.v1.images.edits(request as Parameters<typeof provider.v1.images.edits>[0]);

    const imageUrl = result.data[0]?.url;
    if (!imageUrl) throw new Error("xAI returned no image URL");

    // Download the result image
    const resp = await fetch(imageUrl);
    if (!resp.ok) throw new Error(`Failed to download result image: ${resp.status}`);
    const resultBuffer = Buffer.from(await resp.arrayBuffer());

    // Write to asset
    await fs.writeFile(imgAssetId, "original.png", resultBuffer, projectSlug);

    // Clear pending task
    await deletePendingTask(fs, imgAssetId, projectSlug);

    return { success: true, provider: "xai", refCount: imageRefs.length };
  });
}

import type { VideocityFs } from "videobook-engine";
import { queue, registerJobHandler } from "../queue.js";
import { contentHash } from "../upload.js";
import { buildGoogleNbpImagePayload, type GoogleNbpImageArgs } from "../payload-builders.js";
import type { GoogleFlowImagesRequest } from "@apicity/googleflow";
import {
  callGoogleFlowWithCaptchaRetry,
  createGoogleFlowProvider,
  uploadAssetToGoogleFlow,
  uploadUrlToGoogleFlow,
  withGoogleFlowCaptchaDefaults,
} from "./_google-flow.js";
import type { ImageInput } from "../tools/_image-inputs.js";

type GenerateNanoBananaProGooglePayload = {
  type: "generate_nano_banana_pro_google";
  imgAssetId: string;
  imgAssetDir: string;
  projectSlug: string;
  prompt: string;
  imageInputs: ImageInput[];
  sourceImageIds: string[];
  character_refs?: string[];
  aspect_ratio?: GoogleNbpImageArgs["aspect_ratio"];
  seed?: number;
};

// POST /google-flow/images answers synchronously with
// media[].image.generatedImage.fifeUrl (a signed download URL).
function readFirstImageUrl(res: Record<string, unknown>): string | null {
  const media = res.media;
  if (!Array.isArray(media)) return null;
  for (const entry of media) {
    if (!entry || typeof entry !== "object") continue;
    const image = (entry as Record<string, unknown>).image;
    if (!image || typeof image !== "object") continue;
    const generated = (image as Record<string, unknown>).generatedImage;
    if (!generated || typeof generated !== "object") continue;
    const url = (generated as Record<string, unknown>).fifeUrl;
    if (typeof url === "string" && url !== "") return url;
  }
  return null;
}

function extensionForContentType(contentType: string | null): string {
  if (contentType?.includes("image/jpeg")) return "jpg";
  if (contentType?.includes("image/webp")) return "webp";
  return "png";
}

export function registerGenerateNanoBananaProGoogleJob(fs: VideocityFs): void {
  registerJobHandler("generate_nano_banana_pro_google", async (payload) => {
    const p = payload as GenerateNanoBananaProGooglePayload;
    // Unlike the kie/fal paths there is no async job to poll — the images
    // endpoint blocks until Google Flow finishes rendering — so this handler
    // completes inline (the queue wrapper's owner lease + heartbeat cover the
    // wait) and no pending task is written.
    const provider = createGoogleFlowProvider();

    const referenceIds: string[] = [];
    for (const input of p.imageInputs) {
      referenceIds.push(
        "url" in input
          ? await uploadUrlToGoogleFlow(provider, input.url)
          : await uploadAssetToGoogleFlow(provider, fs, input.assetId, input.filename, p.projectSlug),
      );
    }

    const request = withGoogleFlowCaptchaDefaults(
      buildGoogleNbpImagePayload(
        {
          prompt: p.prompt,
          ...(p.aspect_ratio !== undefined ? { aspect_ratio: p.aspect_ratio } : {}),
          ...(p.seed !== undefined ? { seed: p.seed } : {}),
        },
        referenceIds,
        p.character_refs,
      ) as Record<string, unknown>,
    ) as GoogleFlowImagesRequest;
    await fs.writeMetadata(p.imgAssetId, "generation-payload", request, p.projectSlug);

    const res = await callGoogleFlowWithCaptchaRetry(
      (body) => provider.v1.images(body as GoogleFlowImagesRequest),
      request as Record<string, unknown>,
    );
    const imageUrl = readFirstImageUrl(res as Record<string, unknown>);
    if (!imageUrl) throw new Error("Google Flow image generation returned no image URL");

    const download = await fetch(imageUrl);
    if (!download.ok) {
      throw new Error(`Failed to download image: ${download.status} ${download.statusText}`);
    }
    const ext = extensionForContentType(download.headers.get("content-type"));
    const buffer = Buffer.from(await download.arrayBuffer());
    await fs.writeFile(p.imgAssetId, `original.${ext}`, buffer, p.projectSlug);

    const provenance = {
      source_assets: p.sourceImageIds,
      model: "nano-banana-pro",
      prompt: p.prompt,
      download_url: imageUrl,
      download_url_content_hash: contentHash(buffer),
      ...(p.character_refs ? { character_refs: p.character_refs } : {}),
      ...(p.aspect_ratio !== undefined ? { aspect_ratio: p.aspect_ratio } : {}),
      generated_at: new Date().toISOString(),
    };
    await queue.enqueue(`process-image-${p.imgAssetId}-${Date.now()}`, {
      type: "process_image",
      assetId: p.imgAssetId,
      projectSlug: p.projectSlug,
      extension: `.${ext}`,
      provenance,
    } as unknown as Record<string, unknown>);

    return { success: true };
  });
}

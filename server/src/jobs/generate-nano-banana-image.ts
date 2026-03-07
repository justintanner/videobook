import type { ClipfirstFs } from "clipfirst-fs";
import { readFile, writeFile as fsWriteFile } from "node:fs/promises";
import { join } from "node:path";
import { kie, type TaskResult } from "@nakedapi/kie";
import { registerJobHandler } from "../queue.js";

const LOCK_DURATION_MS = 600_000;

type GenerateNanoBananaImagePayload = {
  type: "generate_nano_banana_image";
  prompt: string;
  imageInputs: Array<{ path: string; filename: string }>;
  imgAssetId: string;
  imgAssetDir: string;
  sourceImageIds: string[];
  projectSlug: string;
  aspectRatio?: string;
  resolution?: string;
  outputFormat?: string;
};

export function registerGenerateNanoBananaImageJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_nano_banana_image", async (payload) => {
    const {
      prompt, imageInputs, imgAssetId, imgAssetDir,
      sourceImageIds, projectSlug, aspectRatio, resolution, outputFormat,
    } = payload as GenerateNanoBananaImagePayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const lockResult = await fs.acquireLock(imgAssetDir, { durationMs: LOCK_DURATION_MS });
    if (!lockResult.ok) throw new Error(`Asset is locked: ${lockResult.error.message}`);

    try {
      const provider = kie({ apiKey, timeout: 60_000 });

      const uploadedUrls: string[] = [];
      for (const { path, filename } of imageInputs) {
        const imageBuffer = await readFile(path);
        const blob = new Blob([imageBuffer]);
        const { downloadUrl } = await provider.uploadMedia({ file: blob, filename });
        uploadedUrls.push(downloadUrl);
      }

      const result: TaskResult = await provider.generate({
        model: "nano-banana-pro",
        input: {
          prompt,
          ...(uploadedUrls.length > 0 ? { image_input: uploadedUrls } : {}),
          ...(aspectRatio !== undefined ? { aspect_ratio: aspectRatio } : {}),
          ...(resolution !== undefined ? { resolution } : {}),
          ...(outputFormat !== undefined ? { output_format: outputFormat } : {}),
        },
      }, { timeoutMs: 600_000 });

      if (result.status === "failed") {
        throw new Error(`Image generation failed: ${result.error ?? "unknown error"}`);
      }

      const imageUrl = result.imageUrl ?? result.urls[0];
      if (!imageUrl) {
        throw new Error("No image URL in API response");
      }

      const response = await fetch(imageUrl);
      if (!response.ok) {
        throw new Error(`Failed to download image: ${response.status} ${response.statusText}`);
      }

      const ext = outputFormat ?? "png";
      const buffer = Buffer.from(await response.arrayBuffer());
      await fsWriteFile(join(imgAssetDir, `original.${ext}`), buffer);

      const origin = {
        source_assets: sourceImageIds,
        model: "nano-banana-pro",
        prompt,
        ...(aspectRatio !== undefined ? { aspect_ratio: aspectRatio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(outputFormat !== undefined ? { output_format: outputFormat } : {}),
        generated_at: new Date().toISOString(),
      };
      await fsWriteFile(join(imgAssetDir, ".origin.json"), JSON.stringify(origin, null, 2));

      await fs.commitOperation("nano_banana_image", imgAssetId, {
        model: "nano-banana-pro",
        prompt,
      }, projectSlug);

      return { success: true };
    } finally {
      await fs.releaseLock(imgAssetDir);
    }
  });
}

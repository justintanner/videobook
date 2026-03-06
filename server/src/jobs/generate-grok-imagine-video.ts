import type { ClipfirstFs } from "clipfirst-fs";
import { readFile, writeFile as fsWriteFile } from "node:fs/promises";
import { join } from "node:path";
import { kie, type TaskResult } from "@nakedapi/kie";
import { registerJobHandler } from "../queue.js";

const LOCK_DURATION_MS = 600_000;

type GenerateGrokImagineVideoPayload = {
  type: "generate_grok_imagine_video";
  imagePath: string;
  imageFilename: string;
  vidAssetId: string;
  vidAssetDir: string;
  sourceImageId: string;
  projectSlug: string;
  prompt?: string;
  mode?: "fun" | "normal" | "spicy";
  duration?: "6" | "10" | "15";
  resolution?: "480p" | "720p";
};

export function registerGenerateGrokImagineVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_grok_imagine_video", async (payload) => {
    const {
      imagePath, imageFilename, vidAssetId, vidAssetDir,
      sourceImageId, projectSlug, prompt, mode, duration, resolution,
    } = payload as GenerateGrokImagineVideoPayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const lockResult = await fs.acquireLock(vidAssetDir, { durationMs: LOCK_DURATION_MS });
    if (!lockResult.ok) throw new Error(`Asset is locked: ${lockResult.error.message}`);

    try {
      const provider = kie({ apiKey, timeout: 60_000 });

      const imageBuffer = await readFile(imagePath);
      const blob = new Blob([imageBuffer]);

      const { downloadUrl } = await provider.uploadMedia({
        file: blob,
        filename: imageFilename,
      });

      const result: TaskResult = await provider.generate({
        model: "grok-imagine/image-to-video",
        input: {
          image_urls: [downloadUrl],
          ...(prompt !== undefined ? { prompt } : {}),
          ...(mode !== undefined ? { mode } : {}),
          ...(duration !== undefined ? { duration } : {}),
          ...(resolution !== undefined ? { resolution } : {}),
        },
      }, { timeoutMs: 600_000 });

      if (result.status === "failed") {
        throw new Error(`Video generation failed: ${result.error ?? "unknown error"}`);
      }

      const videoUrl = result.videoUrl ?? result.urls[0];
      if (!videoUrl) {
        throw new Error("No video URL in API response");
      }

      const response = await fetch(videoUrl);
      if (!response.ok) {
        throw new Error(`Failed to download video: ${response.status} ${response.statusText}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      await fsWriteFile(join(vidAssetDir, "original.mp4"), buffer);

      const origin = {
        source_asset: sourceImageId,
        model: "grok-imagine/image-to-video",
        ...(prompt !== undefined ? { prompt } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        generated_at: new Date().toISOString(),
      };
      await fsWriteFile(join(vidAssetDir, ".origin.json"), JSON.stringify(origin, null, 2));

      await fs.commitOperation("grok_imagine_video", vidAssetId, {
        source: sourceImageId,
        model: "grok-imagine/image-to-video",
      }, projectSlug);

      return { success: true };
    } finally {
      await fs.releaseLock(vidAssetDir);
    }
  });
}

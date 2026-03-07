import type { ClipfirstFs } from "clipfirst-fs";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { join } from "node:path";
import { registerJobHandler } from "../queue.js";
import { deletePendingTask } from "./pending-task.js";

const LOCK_DURATION_MS = 300_000;

type CompleteKieTaskPayload = {
  type: "complete_kie_task";
  taskId: string;
  taskType: "nano_banana_image" | "grok_imagine_video" | "transcribe";
  assetId: string;
  assetDir: string;
  projectSlug: string;
  meta: Record<string, unknown>;
  resultUrls: string[];
  resultObject?: Record<string, unknown>;
};

export function registerCompleteKieTaskJob(fs: ClipfirstFs): void {
  registerJobHandler("complete_kie_task", async (payload) => {
    const {
      taskType, assetId, assetDir, projectSlug, meta,
      resultUrls, resultObject,
    } = payload as CompleteKieTaskPayload;

    const lockResult = await fs.acquireLock(assetDir, { durationMs: LOCK_DURATION_MS });
    if (!lockResult.ok) throw new Error(`Asset is locked: ${lockResult.error.message}`);

    try {
      if (taskType === "nano_banana_image") {
        await completeNanoBananaImage(fs, assetId, assetDir, projectSlug, meta, resultUrls);
      } else if (taskType === "grok_imagine_video") {
        await completeGrokImagineVideo(fs, assetId, assetDir, projectSlug, meta, resultUrls);
      } else if (taskType === "transcribe") {
        await completeTranscribe(fs, assetId, projectSlug, meta, resultObject);
      }

      await deletePendingTask(assetDir);
      return { success: true };
    } finally {
      await fs.releaseLock(assetDir);
    }
  });
}

async function completeNanoBananaImage(
  fs: ClipfirstFs,
  assetId: string,
  assetDir: string,
  projectSlug: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
): Promise<void> {
  const imageUrl = resultUrls[0];
  if (!imageUrl) throw new Error("No image URL in result");

  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`Failed to download image: ${response.status} ${response.statusText}`);

  const ext = (meta.outputFormat as string) ?? "png";
  const buffer = Buffer.from(await response.arrayBuffer());
  await fsWriteFile(join(assetDir, `original.${ext}`), buffer);

  const origin = {
    source_assets: meta.sourceImageIds,
    model: "nano-banana-pro",
    prompt: meta.prompt,
    ...(meta.aspectRatio !== undefined ? { aspect_ratio: meta.aspectRatio } : {}),
    ...(meta.resolution !== undefined ? { resolution: meta.resolution } : {}),
    ...(meta.outputFormat !== undefined ? { output_format: meta.outputFormat } : {}),
    generated_at: new Date().toISOString(),
  };
  await fsWriteFile(join(assetDir, ".origin.json"), JSON.stringify(origin, null, 2));

  await fs.commitOperation("nano_banana_image", assetId, {
    model: "nano-banana-pro",
    prompt: meta.prompt as string,
  }, projectSlug);
}

async function completeGrokImagineVideo(
  fs: ClipfirstFs,
  assetId: string,
  assetDir: string,
  projectSlug: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
): Promise<void> {
  const videoUrl = resultUrls[0];
  if (!videoUrl) throw new Error("No video URL in result");

  const response = await fetch(videoUrl);
  if (!response.ok) throw new Error(`Failed to download video: ${response.status} ${response.statusText}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  await fsWriteFile(join(assetDir, "original.mp4"), buffer);

  const origin = {
    source_asset: meta.sourceImageId,
    model: "grok-imagine/image-to-video",
    ...(meta.prompt !== undefined ? { prompt: meta.prompt } : {}),
    ...(meta.mode !== undefined ? { mode: meta.mode } : {}),
    ...(meta.duration !== undefined ? { duration: meta.duration } : {}),
    ...(meta.resolution !== undefined ? { resolution: meta.resolution } : {}),
    generated_at: new Date().toISOString(),
  };
  await fsWriteFile(join(assetDir, ".origin.json"), JSON.stringify(origin, null, 2));

  await fs.commitOperation("grok_imagine_video", assetId, {
    source: meta.sourceImageId as string,
    model: "grok-imagine/image-to-video",
  }, projectSlug);
}

async function completeTranscribe(
  fs: ClipfirstFs,
  assetId: string,
  projectSlug: string,
  meta: Record<string, unknown>,
  resultObject?: Record<string, unknown>,
): Promise<void> {
  if (!resultObject) throw new Error("No transcription data in result");

  const transcriptionStr = JSON.stringify(resultObject, null, 2);
  const writeResult = await fs.writeFile(assetId, "elevenlabs.json", transcriptionStr, projectSlug);
  if (!writeResult.ok) throw new Error(`Failed to write transcription: ${writeResult.error.message}`);

  await fs.commitOperation("transcribe", assetId, {
    ...(meta.languageCode ? { language_code: meta.languageCode } : {}),
  }, projectSlug);
}

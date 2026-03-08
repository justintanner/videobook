import type { ClipfirstFs } from "clipfirst-fs";
import { join } from "node:path";
import { queue, registerJobHandler } from "../queue.js";
import { findVideoFile } from "../media-files.js";
import { deletePendingTask } from "./pending-task.js";

const LOCK_DURATION_MS = 300_000;

type CompleteKieTaskPayload = {
  type: "complete_kie_task";
  taskId: string;
  taskType: "nano_banana_image" | "grok_imagine_video" | "grok_imagine_image" | "gpt_image" | "transcribe";
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
        await completeNanoBananaImage(fs, assetId, projectSlug, meta, resultUrls);
      } else if (taskType === "grok_imagine_video") {
        await completeGrokImagineVideo(fs, assetId, assetDir, projectSlug, meta, resultUrls);
      } else if (taskType === "grok_imagine_image") {
        await completeGrokImagineImage(fs, assetId, projectSlug, meta, resultUrls);
      } else if (taskType === "gpt_image") {
        await completeGptImage(fs, assetId, projectSlug, meta, resultUrls);
      } else if (taskType === "transcribe") {
        await completeTranscribe(fs, assetId, assetDir, projectSlug, meta, resultObject);
      }

      await deletePendingTask(fs, assetId, projectSlug);
      return { success: true };
    } finally {
      await fs.releaseLock(assetDir);
    }
  });
}

async function completeNanoBananaImage(
  fs: ClipfirstFs,
  assetId: string,
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
  await fs.writeFile(assetId, `original.${ext}`, buffer, projectSlug);

  const origin = {
    source_assets: meta.sourceImageIds,
    model: "nano-banana-pro",
    prompt: meta.prompt,
    ...(meta.aspectRatio !== undefined ? { aspect_ratio: meta.aspectRatio } : {}),
    ...(meta.resolution !== undefined ? { resolution: meta.resolution } : {}),
    ...(meta.outputFormat !== undefined ? { output_format: meta.outputFormat } : {}),
    generated_at: new Date().toISOString(),
  };
  await fs.writeMetadata(assetId, "original", origin, projectSlug);
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
  await fs.writeFile(assetId, "original.mp4", buffer, projectSlug);

  const provenance = {
    source_asset: meta.sourceImageId,
    model: "grok-imagine/image-to-video",
    ...(meta.prompt !== undefined ? { prompt: meta.prompt } : {}),
    ...(meta.mode !== undefined ? { mode: meta.mode } : {}),
    ...(meta.duration !== undefined ? { duration: meta.duration } : {}),
    ...(meta.resolution !== undefined ? { resolution: meta.resolution } : {}),
    generated_at: new Date().toISOString(),
  };

  const videoPath = join(assetDir, "original.mp4");
  const jobId = `process-video-${assetId}-${Date.now()}`;
  await queue.enqueue(jobId, {
    type: "process_video",
    videoPath,
    assetId,
    assetDir,
    projectSlug,
    provenance,
  } as unknown as Record<string, unknown>);
}

async function completeGrokImagineImage(
  fs: ClipfirstFs,
  assetId: string,
  projectSlug: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
): Promise<void> {
  const imageUrl = resultUrls[0];
  if (!imageUrl) throw new Error("No image URL in result");

  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`Failed to download image: ${response.status} ${response.statusText}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(assetId, "original.png", buffer, projectSlug);

  const origin = {
    source_asset: meta.sourceImageId,
    model: "grok-imagine/image-to-image",
    ...(meta.prompt !== undefined ? { prompt: meta.prompt } : {}),
    generated_at: new Date().toISOString(),
  };
  await fs.writeMetadata(assetId, "original", origin, projectSlug);
}

async function completeGptImage(
  fs: ClipfirstFs,
  assetId: string,
  projectSlug: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
): Promise<void> {
  const imageUrl = resultUrls[0];
  if (!imageUrl) throw new Error("No image URL in result");

  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`Failed to download image: ${response.status} ${response.statusText}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(assetId, "original.png", buffer, projectSlug);

  const origin = {
    source_assets: meta.sourceImageIds,
    model: "gpt-image/1.5-image-to-image",
    prompt: meta.prompt,
    ...(meta.aspectRatio !== undefined ? { aspect_ratio: meta.aspectRatio } : {}),
    ...(meta.quality !== undefined ? { quality: meta.quality } : {}),
    generated_at: new Date().toISOString(),
  };
  await fs.writeMetadata(assetId, "original", origin, projectSlug);
}

async function completeTranscribe(
  fs: ClipfirstFs,
  assetId: string,
  assetDir: string,
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

  if (meta.autoRender) {
    const manifestResult = await fs.getManifest(assetId, projectSlug);
    if (!manifestResult.ok) throw new Error(`Failed to get manifest for auto-render: ${manifestResult.error.message}`);

    const videoFile = findVideoFile(manifestResult.value.files);
    if (!videoFile) throw new Error(`No video file found for auto-render: ${assetId}`);

    const videoPath = join(assetDir, videoFile.name);
    const jobId = `auto-render-${assetId}-${Date.now()}`;

    await queue.enqueue(jobId, {
      type: "render_video",
      assetId,
      assetDir,
      videoPath,
      videoFilename: videoFile.name,
      projectSlug,
      orientations: ["landscape"],
      subtitlesEnabled: false,
      highlightStyle: "tikdance",
      position: "bottom",
      fontSize: "medium",
      textColor: "#F8FAFC",
      highlightColor: "#991B1B",
      audioFadeIn: 150,
      audioFadeOut: 100,
      audioVolume: 100,
      hasElevenlabs: false,
      osgImagePath: null,
      osgPosition: "top-right",
    });
  }
}

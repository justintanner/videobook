import type { ClipfirstFs } from "clipfirst-fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFile, unlink, readFile as readFsFile } from "node:fs/promises";
import { queue, registerJobHandler } from "../queue.js";
import { findVideoFile } from "../media-files.js";
import { contentHash } from "../upload.js";
import { runFfmpeg } from "../ffmpeg.js";
import { deletePendingTask } from "./pending-task.js";
import { readStoredRenderDefaults, readAnalysisRecommendations } from "../tools/sync.js";

const LOCK_DURATION_MS = 300_000;

type CompleteKieTaskPayload = {
  type: "complete_kie_task";
  taskId: string;
  taskType: "nano_banana_image" | "qwen2_image_edit" | "grok_imagine_video" | "grok_imagine_image" | "grok_imagine_text" | "gpt_image" | "kling30_video" | "seedance2_video" | "wan27_i2v_video" | "wan27_videoedit_video" | "wan27_r2v_video" | "wan27_extend_video" | "wan27_image" | "wan27_image_pro" | "transcribe" | "fal_transcribe" | "isolate_vocals" | "xai_grok_imagine_video" | "xai_grok_imagine_ref_video" | "grok_imagine_extend_video" | "alibaba_video" | "alibaba_image" | "alibaba_image_pro" | "alibaba_qwen_image" | "alibaba_qwen_image_edit" | "fal_seedance2_i2v" | "fal_seedance2_t2v" | "fal_seedance2_r2v" | "fal_seedance2_fast_i2v" | "fal_seedance2_fast_t2v" | "fal_seedance2_fast_r2v" | "fal_nano_banana_pro" | "fal_nano_banana_pro_edit" | "fal_nano_banana" | "fal_nano_banana_edit" | "fal_nano_banana_2" | "fal_nano_banana_2_edit" | "fal_qwen_image" | "fal_qwen_image_edit" | "fal_gpt_image_1_5" | "fal_gpt_image_1_5_edit" | "fal_seedream_v5_lite" | "fal_seedream_v5_lite_edit" | "fal_wan27" | "fal_wan27_edit" | "fal_wan27_pro" | "fal_wan27_pro_edit" | "fal_wan27_t2v" | "fal_wan27_i2v" | "fal_wan27_r2v" | "fal_wan27_videoedit" | "fal_grok_imagine_image" | "fal_grok_imagine_image_edit" | "fal_sora2_t2v" | "fal_sora2_i2v" | "fal_veo31_t2v" | "fal_veo31_i2v" | "fal_kling_v3_pro_i2v" | "fal_kling_v3_pro_t2v" | "fal_kling_v3_standard_i2v" | "fal_kling_v3_standard_t2v" | "fal_grok_imagine_video_i2v";
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
      taskId, taskType, assetId, projectSlug, meta,
      resultUrls, resultObject,
    } = payload as CompleteKieTaskPayload;

    // Resolve the asset directory at runtime so renames don't break completion.
    const assetDirResult = await fs.resolveAssetDir(assetId, projectSlug);
    if (!assetDirResult.ok) {
      await deletePendingTask(fs, assetId, projectSlug);
      return { success: true, skipped: true };
    }
    const assetDir = assetDirResult.value;

    const lockResult = await fs.acquireLock(assetDir, { durationMs: LOCK_DURATION_MS, data: { state: "generating" } });
    if (!lockResult.ok) {
      // LOCKED means another completion job for this same asset is already
      // running (sync can enqueue duplicates between polls because
      // .kie-task.json isn't cleared until the completion job finishes).
      // Treat as a no-op — the other job will finish the work.
      if (lockResult.error.code === "LOCKED") {
        console.log(`[complete_kie_task] ${assetId} already being completed, skipping duplicate`);
        return { success: true, skipped: true };
      }
      throw new Error(`Asset is locked: ${lockResult.error.message}`);
    }

    try {
      if (taskType === "nano_banana_image") {
        await completeNanoBananaImage(fs, assetId, projectSlug, meta, resultUrls);
      } else if (taskType === "qwen2_image_edit") {
        await completeQwen2ImageEdit(fs, assetId, projectSlug, meta, resultUrls);
      } else if (taskType === "kling30_video") {
        await completeKling30Video(fs, assetId, assetDir, projectSlug, meta, resultUrls);
      } else if (taskType === "seedance2_video") {
        await completeSeedance2Video(fs, assetId, assetDir, projectSlug, meta, resultUrls, taskId);
      } else if (taskType === "grok_imagine_video" || taskType === "xai_grok_imagine_video" || taskType === "xai_grok_imagine_ref_video" || taskType === "grok_imagine_extend_video") {
        await completeGrokImagineVideo(fs, assetId, assetDir, projectSlug, meta, resultUrls, taskType, taskId);
      } else if (taskType === "wan27_i2v_video" || taskType === "wan27_videoedit_video" || taskType === "wan27_r2v_video" || taskType === "wan27_extend_video") {
        await completeWan27Video(fs, assetId, assetDir, projectSlug, meta, resultUrls, taskId);
      } else if (taskType === "wan27_image" || taskType === "wan27_image_pro") {
        await completeWan27Image(fs, assetId, projectSlug, meta, resultUrls, taskType);
      } else if (taskType === "alibaba_video") {
        await completeAlibabaVideo(fs, assetId, assetDir, projectSlug, meta, resultUrls, taskId);
      } else if (taskType === "alibaba_image" || taskType === "alibaba_image_pro") {
        await completeAlibabaImage(fs, assetId, projectSlug, meta, resultUrls, taskType);
      } else if (taskType === "alibaba_qwen_image" || taskType === "alibaba_qwen_image_edit") {
        await completeAlibabaQwenImage(fs, assetId, projectSlug, meta, resultUrls, taskType);
      } else if (taskType === "grok_imagine_image" || taskType === "grok_imagine_text") {
        await completeGrokImagineImage(fs, assetId, projectSlug, meta, resultUrls);
      } else if (taskType === "gpt_image") {
        await completeGptImage(fs, assetId, projectSlug, meta, resultUrls);
      } else if (taskType === "transcribe" || taskType === "fal_transcribe") {
        await completeTranscribe(fs, assetId, assetDir, projectSlug, meta, resultObject);
      } else if (taskType === "isolate_vocals") {
        await completeIsolateVocals(fs, assetId, projectSlug, meta, resultUrls);
      } else if (taskType.startsWith("fal_")) {
        const urls = extractFalUrls(taskType, resultObject);
        if (
          taskType === "fal_seedance2_i2v" || taskType === "fal_seedance2_t2v" || taskType === "fal_seedance2_r2v"
          || taskType === "fal_seedance2_fast_i2v" || taskType === "fal_seedance2_fast_t2v" || taskType === "fal_seedance2_fast_r2v"
          || taskType === "fal_sora2_t2v" || taskType === "fal_sora2_i2v"
          || taskType === "fal_veo31_t2v" || taskType === "fal_veo31_i2v"
          || taskType === "fal_kling_v3_pro_i2v" || taskType === "fal_kling_v3_pro_t2v"
          || taskType === "fal_kling_v3_standard_i2v" || taskType === "fal_kling_v3_standard_t2v"
          || taskType === "fal_wan27_t2v" || taskType === "fal_wan27_i2v"
          || taskType === "fal_wan27_r2v" || taskType === "fal_wan27_videoedit"
          || taskType === "fal_grok_imagine_video_i2v"
        ) {
          await completeSeedance2Video(fs, assetId, assetDir, projectSlug, meta, urls, taskId);
        } else if (taskType === "fal_nano_banana_pro" || taskType === "fal_nano_banana_pro_edit") {
          await completeNanoBananaImage(fs, assetId, projectSlug, meta, urls);
        } else if (
          taskType === "fal_wan27" || taskType === "fal_wan27_edit" ||
          taskType === "fal_wan27_pro" || taskType === "fal_wan27_pro_edit"
        ) {
          const variant = taskType === "fal_wan27_pro" || taskType === "fal_wan27_pro_edit"
            ? "wan27_image_pro" : "wan27_image";
          await completeWan27Image(fs, assetId, projectSlug, meta, urls, variant);
        } else if (taskType === "fal_grok_imagine_image" || taskType === "fal_grok_imagine_image_edit") {
          await completeGrokImagineImage(fs, assetId, projectSlug, meta, urls);
        } else if (taskType === "fal_seedream_v5_lite" || taskType === "fal_seedream_v5_lite_edit") {
          await completeSeedreamV5LiteImage(fs, assetId, projectSlug, meta, urls, taskType);
        }
      }

      await deletePendingTask(fs, assetId, projectSlug);
      return { success: true };
    } finally {
      await fs.releaseLock(assetDir);
    }
  });
}

const FAL_VIDEO_TASK_PREFIXES = [
  "fal_seedance2_",
  "fal_sora2_",
  "fal_veo31_",
  "fal_kling_v3_pro_",
  "fal_kling_v3_standard_",
  "fal_wan27_t2v",
  "fal_wan27_i2v",
  "fal_wan27_r2v",
  "fal_wan27_videoedit",
  "fal_grok_imagine_video_",
];

function extractFalUrls(taskType: string, resultObject?: Record<string, unknown>): string[] {
  if (!resultObject) return [];
  if (FAL_VIDEO_TASK_PREFIXES.some((prefix) => taskType.startsWith(prefix))) {
    const v = (resultObject as { video?: { url?: string } }).video?.url;
    return typeof v === "string" ? [v] : [];
  }
  const images = (resultObject as { images?: { url?: string }[] }).images;
  if (!Array.isArray(images)) return [];
  return images
    .map((i) => i?.url)
    .filter((u): u is string => typeof u === "string");
}

async function completeSeedreamV5LiteImage(
  fs: ClipfirstFs,
  assetId: string,
  projectSlug: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
  taskType: string,
): Promise<void> {
  const imageUrl = resultUrls[0];
  if (!imageUrl) throw new Error("No image URL in result");

  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`Failed to download image: ${response.status} ${response.statusText}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(assetId, "original.png", buffer, projectSlug);

  const origin = {
    source_assets: meta.sourceImageIds,
    model: taskType === "fal_seedream_v5_lite_edit" ? "bytedance/seedream-v5-lite-edit" : "bytedance/seedream-v5-lite",
    prompt: meta.prompt,
    download_url: imageUrl,
    download_url_content_hash: contentHash(buffer),
    ...(meta.imageSize !== undefined ? { image_size: meta.imageSize } : {}),
    ...(meta.seed !== undefined ? { seed: meta.seed } : {}),
    generated_at: new Date().toISOString(),
  };
  const jobId = `process-image-${assetId}-${Date.now()}`;
  await queue.enqueue(jobId, {
    type: "process_image",
    assetId,
    projectSlug,
    extension: ".png",
    provenance: origin,
  } as unknown as Record<string, unknown>);
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
    download_url: imageUrl,
    download_url_content_hash: contentHash(buffer),
    ...(meta.aspectRatio !== undefined ? { aspect_ratio: meta.aspectRatio } : {}),
    ...(meta.resolution !== undefined ? { resolution: meta.resolution } : {}),
    ...(meta.outputFormat !== undefined ? { output_format: meta.outputFormat } : {}),
    generated_at: new Date().toISOString(),
  };
  const jobId = `process-image-${assetId}-${Date.now()}`;
  await queue.enqueue(jobId, {
    type: "process_image",
    assetId,
    projectSlug,
    extension: `.${ext}`,
    provenance: origin,
  } as unknown as Record<string, unknown>);
}

async function completeWan27Image(
  fs: ClipfirstFs,
  assetId: string,
  projectSlug: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
  taskType: string,
): Promise<void> {
  const imageUrl = resultUrls[0];
  if (!imageUrl) throw new Error("No image URL in result");

  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`Failed to download image: ${response.status} ${response.statusText}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(assetId, "original.png", buffer, projectSlug);

  const origin = {
    source_assets: meta.sourceImageIds,
    model: taskType === "wan27_image_pro" ? "wan/2-7-image-pro" : "wan/2-7-image",
    prompt: meta.prompt,
    download_url: imageUrl,
    download_url_content_hash: contentHash(buffer),
    ...(meta.aspectRatio !== undefined ? { aspect_ratio: meta.aspectRatio } : {}),
    ...(meta.resolution !== undefined ? { resolution: meta.resolution } : {}),
    ...(meta.seed !== undefined ? { seed: meta.seed } : {}),
    generated_at: new Date().toISOString(),
  };
  const jobId = `process-image-${assetId}-${Date.now()}`;
  await queue.enqueue(jobId, {
    type: "process_image",
    assetId,
    projectSlug,
    extension: ".png",
    provenance: origin,
  } as unknown as Record<string, unknown>);
}

async function completeQwen2ImageEdit(
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
    model: "qwen2/image-edit",
    prompt: meta.prompt,
    download_url: imageUrl,
    download_url_content_hash: contentHash(buffer),
    ...(meta.imageSize !== undefined ? { image_size: meta.imageSize } : {}),
    ...(meta.outputFormat !== undefined ? { output_format: meta.outputFormat } : {}),
    ...(meta.seed !== undefined ? { seed: meta.seed } : {}),
    generated_at: new Date().toISOString(),
  };
  const jobId = `process-image-${assetId}-${Date.now()}`;
  await queue.enqueue(jobId, {
    type: "process_image",
    assetId,
    projectSlug,
    extension: `.${ext}`,
    provenance: origin,
  } as unknown as Record<string, unknown>);
}

async function completeKling30Video(
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
    source_assets: meta.sourceImageIds,
    model: "kling-3.0/video",
    download_url: videoUrl,
    download_url_content_hash: contentHash(buffer),
    ...(meta.prompt !== undefined ? { prompt: meta.prompt } : {}),
    ...(meta.mode !== undefined ? { mode: meta.mode } : {}),
    ...(meta.duration !== undefined ? { duration: meta.duration } : {}),
    ...(meta.sound !== undefined ? { sound: meta.sound } : {}),
    ...(meta.aspect_ratio !== undefined ? { aspect_ratio: meta.aspect_ratio } : {}),
    ...(meta.multi_shots !== undefined ? { multi_shots: meta.multi_shots } : {}),
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

async function completeSeedance2Video(
  fs: ClipfirstFs,
  assetId: string,
  assetDir: string,
  projectSlug: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
  taskId?: string,
): Promise<void> {
  const videoUrl = resultUrls[0];
  if (!videoUrl) throw new Error("No video URL in result");

  const response = await fetch(videoUrl);
  if (!response.ok) throw new Error(`Failed to download video: ${response.status} ${response.statusText}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(assetId, "original.mp4", buffer, projectSlug);

  // Optionally save the returned last frame as a secondary image file
  if (meta.return_last_frame === true && resultUrls[1]) {
    const frameResponse = await fetch(resultUrls[1]);
    if (frameResponse.ok) {
      const frameBuffer = Buffer.from(await frameResponse.arrayBuffer());
      await fs.writeFile(assetId, "last_frame.png", frameBuffer, projectSlug);
    }
  }

  const provenance = {
    source_images: meta.sourceImageIds,
    source_videos: meta.sourceVideoIds,
    source_audios: meta.sourceAudioIds,
    model: "bytedance/seedance-2-fast",
    download_url: videoUrl,
    download_url_content_hash: contentHash(buffer),
    ...(meta.mode !== undefined ? { seedance_mode: meta.mode } : {}),
    ...(meta.prompt !== undefined ? { prompt: meta.prompt } : {}),
    generated_at: new Date().toISOString(),
  };

  const videoPath = join(assetDir, "original.mp4");

  // Persist Kie taskId for future operations
  if (taskId !== undefined) {
    await fs.writeMetadata(assetId, "kie-task-id", { taskId }, projectSlug);
  }

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

async function completeWan27Video(
  fs: ClipfirstFs,
  assetId: string,
  assetDir: string,
  projectSlug: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
  taskId?: string,
): Promise<void> {
  const videoUrl = resultUrls[0];
  if (!videoUrl) throw new Error("No video URL in result");

  const response = await fetch(videoUrl);
  if (!response.ok) throw new Error(`Failed to download video: ${response.status} ${response.statusText}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(assetId, "original.mp4", buffer, projectSlug);

  const provenance = {
    source_images: meta.sourceImageIds,
    source_videos: meta.sourceVideoIds,
    source_audios: meta.sourceAudioIds,
    model: meta.mode === "reference" ? "wan/2-7-r2v" : "wan/2-7-image-to-video",
    download_url: videoUrl,
    download_url_content_hash: contentHash(buffer),
    ...(meta.prompt !== undefined ? { prompt: meta.prompt } : {}),
    generated_at: new Date().toISOString(),
  };

  const videoPath = join(assetDir, "original.mp4");

  if (taskId !== undefined) {
    await fs.writeMetadata(assetId, "kie-task-id", { taskId }, projectSlug);
  }

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

async function completeGrokImagineVideo(
  fs: ClipfirstFs,
  assetId: string,
  assetDir: string,
  projectSlug: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
  taskType: string,
  taskId?: string,
): Promise<void> {
  const videoUrl = resultUrls[0];
  if (!videoUrl) throw new Error("No video URL in result");

  const response = await fetch(videoUrl);
  if (!response.ok) throw new Error(`Failed to download video: ${response.status} ${response.statusText}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(assetId, "original.mp4", buffer, projectSlug);

  const provenance = {
    source_asset: meta.sourceVideoId ?? meta.sourceImageId,
    model: meta.sourceVideoId ? "grok-imagine/video-extension" : "grok-imagine/image-to-video",
    download_url: videoUrl,
    download_url_content_hash: contentHash(buffer),
    ...(meta.prompt !== undefined ? { prompt: meta.prompt } : {}),
    ...(meta.mode !== undefined ? { mode: meta.mode } : {}),
    ...(meta.duration !== undefined ? { duration: meta.duration } : {}),
    ...(meta.resolution !== undefined ? { resolution: meta.resolution } : {}),
    generated_at: new Date().toISOString(),
  };

  const videoPath = join(assetDir, "original.mp4");

  // Persist Kie taskId for future extend operations
  if (taskId !== undefined && !taskType.startsWith("xai_")) {
    await fs.writeMetadata(assetId, "kie-task-id", { taskId }, projectSlug);
  }

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
    download_url: imageUrl,
    download_url_content_hash: contentHash(buffer),
    ...(meta.prompt !== undefined ? { prompt: meta.prompt } : {}),
    generated_at: new Date().toISOString(),
  };
  const jobId = `process-image-${assetId}-${Date.now()}`;
  await queue.enqueue(jobId, {
    type: "process_image",
    assetId,
    projectSlug,
    extension: ".png",
    provenance: origin,
  } as unknown as Record<string, unknown>);
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
    download_url: imageUrl,
    download_url_content_hash: contentHash(buffer),
    ...(meta.aspectRatio !== undefined ? { aspect_ratio: meta.aspectRatio } : {}),
    ...(meta.quality !== undefined ? { quality: meta.quality } : {}),
    generated_at: new Date().toISOString(),
  };
  const jobId = `process-image-${assetId}-${Date.now()}`;
  await queue.enqueue(jobId, {
    type: "process_image",
    assetId,
    projectSlug,
    extension: ".png",
    provenance: origin,
  } as unknown as Record<string, unknown>);
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
    const jobId = `auto-render-${assetId}`;

    // Read orientation from timeline config
    const timelineResult = await fs.readProjectMeta<{ render?: string }>("timeline", projectSlug);
    const orientation = timelineResult.ok
      ? (Array.isArray(timelineResult.value.render) ? timelineResult.value.render[0] : timelineResult.value.render) ?? "landscape"
      : "landscape";

    const stored = await readStoredRenderDefaults(fs, assetId, projectSlug, orientation);
    const analysisRecs = await readAnalysisRecommendations(fs, assetId, projectSlug);
    // Enable subs after transcription unless burned-in subs were detected
    const subtitlesEnabled = analysisRecs.subtitlesEnabled !== false;
    await queue.enqueue(jobId, {
      type: "render_project",
      projectSlug,
      orientation,
      assets: [{
        assetId,
        assetDir,
        videoPath,
        videoFilename: videoFile.name,
        hasElevenlabs: true,
      }],
      subtitlesEnabled,
      highlightStyle: stored.highlightStyle as string,
      position: stored.position as string,
      fontSize: stored.fontSize as string,
      textColor: stored.textColor as string,
      highlightColor: stored.highlightColor as string,
      audioFadeIn: stored.audioFadeIn as number,
      audioFadeOut: stored.audioFadeOut as number,
      audioVolume: stored.audioVolume as number,
      osgImagePath: (stored.osgImagePath as string | null) ?? null,
      osgPosition: stored.osgPosition as string,
      backgroundMode: stored.backgroundMode as string,
    });
  }
}

async function completeIsolateVocals(
  fs: ClipfirstFs,
  assetId: string,
  projectSlug: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
): Promise<void> {
  const vocalsUrl = resultUrls[0];
  if (!vocalsUrl) throw new Error("No vocals URL in result");

  const response = await fetch(vocalsUrl);
  if (!response.ok) throw new Error(`Failed to download vocals: ${response.status} ${response.statusText}`);

  let vocalsBuffer = Buffer.from(await response.arrayBuffer());

  // Trim back to original duration if audio was padded before upload
  const originalDuration = meta.originalDuration as number | undefined;
  if (originalDuration !== undefined) {
    const tmpIn = join(tmpdir(), `isolate-trim-in-${Date.now()}.mp3`);
    const tmpOut = join(tmpdir(), `isolate-trim-out-${Date.now()}.mp3`);
    try {
      await writeFile(tmpIn, vocalsBuffer);
      await runFfmpeg(["-y", "-i", tmpIn, "-t", String(originalDuration), tmpOut]);
      vocalsBuffer = await readFsFile(tmpOut);
    } finally {
      await unlink(tmpIn).catch(() => {});
      await unlink(tmpOut).catch(() => {});
    }
  }

  const isAudioAsset = meta.isAudioAsset as boolean;

  if (isAudioAsset) {
    // Audio assets: write mix.mp3 and .mix.json
    await fs.writeFile(assetId, "mix.mp3", vocalsBuffer, projectSlug);
    const mixSettings = { volume: 100, fadeIn: 0, fadeOut: 0 };
    await fs.writeFile(assetId, ".mix.json", JSON.stringify(mixSettings, null, 2), projectSlug);
  } else {
    // Video assets: write audio_vocals.mp3
    await fs.writeFile(assetId, "audio_vocals.mp3", vocalsBuffer, projectSlug);

    // Optionally write background audio if a second URL exists
    if (resultUrls[1]) {
      const bgResponse = await fetch(resultUrls[1]);
      if (bgResponse.ok) {
        let bgBuffer = Buffer.from(await bgResponse.arrayBuffer());
        if (originalDuration !== undefined) {
          const tmpBgIn = join(tmpdir(), `isolate-bg-in-${Date.now()}.mp3`);
          const tmpBgOut = join(tmpdir(), `isolate-bg-out-${Date.now()}.mp3`);
          try {
            await writeFile(tmpBgIn, bgBuffer);
            await runFfmpeg(["-y", "-i", tmpBgIn, "-t", String(originalDuration), tmpBgOut]);
            bgBuffer = await readFsFile(tmpBgOut);
          } finally {
            await unlink(tmpBgIn).catch(() => {});
            await unlink(tmpBgOut).catch(() => {});
          }
        }
        await fs.writeFile(assetId, "audio_background.mp3", bgBuffer, projectSlug);
      }
    }
  }

  await fs.commitOperation("isolate_vocals", assetId, { mode: "cloud" }, projectSlug);
}

function extensionFromUrl(url: string, fallback: string): string {
  try {
    const pathname = new URL(url).pathname;
    const match = /\.([a-zA-Z0-9]{1,5})$/.exec(pathname);
    if (match) return match[1].toLowerCase();
  } catch {
    // ignore malformed URLs
  }
  return fallback;
}

async function readPayloadModel(
  fs: ClipfirstFs,
  assetId: string,
  projectSlug: string,
): Promise<string | undefined> {
  const result = await fs.readMetadata<{ model?: string }>(assetId, "generation-payload", projectSlug);
  if (!result.ok) return undefined;
  return typeof result.value.model === "string" ? result.value.model : undefined;
}

async function completeAlibabaVideo(
  fs: ClipfirstFs,
  assetId: string,
  assetDir: string,
  projectSlug: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
  taskId?: string,
): Promise<void> {
  const videoUrl = resultUrls[0];
  if (!videoUrl) throw new Error("No video URL in Alibaba result");

  const response = await fetch(videoUrl);
  if (!response.ok) throw new Error(`Failed to download video: ${response.status} ${response.statusText}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(assetId, "original.mp4", buffer, projectSlug);

  const modelName = (await readPayloadModel(fs, assetId, projectSlug)) ?? "alibaba/wan2.7-video";

  const provenance = {
    source_images: meta.sourceImageIds,
    source_videos: meta.sourceVideoIds,
    source_audios: meta.sourceAudioIds,
    model: modelName,
    download_url: videoUrl,
    download_url_content_hash: contentHash(buffer),
    ...(meta.prompt !== undefined ? { prompt: meta.prompt } : {}),
    generated_at: new Date().toISOString(),
  };

  if (taskId !== undefined) {
    await fs.writeMetadata(assetId, "alibaba-task-id", { taskId }, projectSlug);
  }

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

async function completeAlibabaQwenImage(
  fs: ClipfirstFs,
  assetId: string,
  projectSlug: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
  taskType: "alibaba_qwen_image" | "alibaba_qwen_image_edit",
): Promise<void> {
  const imageUrl = resultUrls[0];
  if (!imageUrl) throw new Error("No image URL in Alibaba Qwen result");

  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`Failed to download image: ${response.status} ${response.statusText}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  const ext = extensionFromUrl(imageUrl, "png");
  await fs.writeFile(assetId, `original.${ext}`, buffer, projectSlug);

  const fallbackModel = taskType === "alibaba_qwen_image_edit"
    ? "alibaba/qwen-image-edit-plus"
    : "alibaba/qwen-image-2.0-pro";
  const modelName = (await readPayloadModel(fs, assetId, projectSlug))
    ?? (typeof meta.model === "string" ? `alibaba/${meta.model}` : fallbackModel);

  const origin = {
    source_assets: meta.sourceImageIds,
    model: modelName,
    prompt: meta.prompt,
    download_url: imageUrl,
    download_url_content_hash: contentHash(buffer),
    ...(meta.size !== undefined ? { size: meta.size } : {}),
    ...(meta.n !== undefined ? { n: meta.n } : {}),
    ...(meta.negativePrompt !== undefined ? { negative_prompt: meta.negativePrompt } : {}),
    ...(meta.promptExtend !== undefined ? { prompt_extend: meta.promptExtend } : {}),
    ...(meta.watermark !== undefined ? { watermark: meta.watermark } : {}),
    ...(meta.seed !== undefined ? { seed: meta.seed } : {}),
    ...(resultUrls.length > 1 ? { additional_urls: resultUrls.slice(1) } : {}),
    generated_at: new Date().toISOString(),
  };
  const jobId = `process-image-${assetId}-${Date.now()}`;
  await queue.enqueue(jobId, {
    type: "process_image",
    assetId,
    projectSlug,
    extension: `.${ext}`,
    provenance: origin,
  } as unknown as Record<string, unknown>);
}

async function completeAlibabaImage(
  fs: ClipfirstFs,
  assetId: string,
  projectSlug: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
  taskType: "alibaba_image" | "alibaba_image_pro",
): Promise<void> {
  const imageUrl = resultUrls[0];
  if (!imageUrl) throw new Error("No image URL in Alibaba result");

  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`Failed to download image: ${response.status} ${response.statusText}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  const ext = extensionFromUrl(imageUrl, "png");
  await fs.writeFile(assetId, `original.${ext}`, buffer, projectSlug);

  const modelName = (await readPayloadModel(fs, assetId, projectSlug))
    ?? (taskType === "alibaba_image_pro" ? "alibaba/wan2.7-image-pro" : "alibaba/wan2.7-image");

  const origin = {
    source_assets: meta.sourceImageIds,
    model: modelName,
    prompt: meta.prompt,
    download_url: imageUrl,
    download_url_content_hash: contentHash(buffer),
    ...(meta.size !== undefined ? { size: meta.size } : {}),
    ...(meta.n !== undefined ? { n: meta.n } : {}),
    ...(meta.watermark !== undefined ? { watermark: meta.watermark } : {}),
    ...(meta.thinkingMode !== undefined ? { thinking_mode: meta.thinkingMode } : {}),
    ...(meta.seed !== undefined ? { seed: meta.seed } : {}),
    generated_at: new Date().toISOString(),
  };
  const jobId = `process-image-${assetId}-${Date.now()}`;
  await queue.enqueue(jobId, {
    type: "process_image",
    assetId,
    projectSlug,
    extension: `.${ext}`,
    provenance: origin,
  } as unknown as Record<string, unknown>);
}

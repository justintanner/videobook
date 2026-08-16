import type { Engine } from "videobook-engine";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFile, unlink, readFile as readFsFile } from "node:fs/promises";
import { queue, registerJobHandler } from "../queue.js";
import { contentHash } from "../upload.js";
import { runFfmpeg } from "../ffmpeg.js";
import { downloadUrlIntoAsset } from "./_download-into-asset.js";

const LOCK_DURATION_MS = 300_000;

const TASK_TYPES_BY_COMPLETION_FAMILY = {
  nanoBananaImage: [
    "nano_banana_image",
    "fal_nano_banana_pro",
    "fal_nano_banana_pro_edit",
    "fal_nano_banana",
    "fal_nano_banana_edit",
    "fal_nano_banana_2",
    "fal_nano_banana_2_edit",
    "fal_nano_banana_2_lite",
    "fal_nano_banana_2_lite_edit",
  ],
  qwenImage: ["qwen2_image_edit", "fal_qwen_image", "fal_qwen_image_edit"],
  seedreamImage: ["seedream_text_image", "seedream_image"],
  seedreamV5Image: ["fal_seedream_v5_lite", "fal_seedream_v5_lite_edit"],
  klingVideo: ["kling30_video", "kling30_motion_control_video"],
  providerVideo: [
    "seedance2_video",
    "fal_seedance2_i2v",
    "fal_seedance2_t2v",
    "fal_seedance2_r2v",
    "fal_seedance2_fast_i2v",
    "fal_seedance2_fast_t2v",
    "fal_seedance2_fast_r2v",
    "fal_wan27_t2v",
    "fal_wan27_i2v",
    "fal_wan27_r2v",
    "fal_wan27_videoedit",
    "fal_kling_v3_pro_i2v",
    "fal_kling_v3_pro_t2v",
    "fal_kling_v3_standard_i2v",
    "fal_kling_v3_standard_t2v",
    "fal_grok_imagine_video_i2v",
    "fal_grok_imagine_video_r2v",
    "fal_grok_imagine_video_extend",
    "fal_grok_imagine_video_edit",
  ],
  grokVideo: [
    "grok_imagine_video",
    "grok_imagine_t2v_video",
    "xai_grok_imagine_video",
    "xai_grok_imagine_ref_video",
    "grok_imagine_extend_video",
    "grok_imagine_upscale_video",
  ],
  wanVideo: [
    "wan27_t2v_video",
    "wan27_i2v_video",
    "wan27_videoedit_video",
    "wan27_r2v_video",
    "wan27_extend_video",
  ],
  happyHorseVideo: [
    "happyhorse_t2v_video",
    "happyhorse_i2v_video",
    "happyhorse_ref_video",
    "happyhorse_videoedit_video",
  ],
  miniMaxVideo: [
    "minimax_h3_t2v_video",
    "minimax_h3_i2v_video",
    "minimax_h3_r2v_video",
  ],
  lipSyncVideo: ["volcengine_lipsync_video"],
  omnihumanVideo: ["omnihuman_video"],
  wanImage: [
    "wan27_image",
    "wan27_image_pro",
    "fal_wan27",
    "fal_wan27_edit",
    "fal_wan27_pro",
    "fal_wan27_pro_edit",
  ],
  alibabaVideo: ["alibaba_video"],
  alibabaImage: ["alibaba_image", "alibaba_image_pro"],
  alibabaQwenImage: ["alibaba_qwen_image", "alibaba_qwen_image_edit"],
  grokImage: [
    "grok_imagine_image",
    "grok_imagine_text",
    "fal_grok_imagine_image",
    "fal_grok_imagine_image_edit",
  ],
  gptImage: ["gpt_image", "gpt_image_text"],
  isolateVocals: ["isolate_vocals"],
} as const;

type ProviderCompletionFamily = keyof typeof TASK_TYPES_BY_COMPLETION_FAMILY;

const COMPLETION_FAMILY_BY_TASK_TYPE = new Map<string, ProviderCompletionFamily>(
  Object.entries(TASK_TYPES_BY_COMPLETION_FAMILY).flatMap(([family, taskTypes]) =>
    taskTypes.map((taskType) => [taskType, family as ProviderCompletionFamily]),
  ),
);

export function completionFamilyForTaskType(taskType: string): ProviderCompletionFamily | undefined {
  return COMPLETION_FAMILY_BY_TASK_TYPE.get(taskType);
}

type CompleteProviderTaskPayload = {
  type: "complete_kie_task";
  taskId: string;
  taskType: string;
  assetId: string;
  assetDir: string;
  bookId: string;
  meta: Record<string, unknown>;
  resultUrls: string[];
  resultObject?: Record<string, unknown>;
};

export function registerCompleteProviderTaskJob(fs: Engine): void {
  registerJobHandler("complete_kie_task", async (payload, ctx) => {
    const {
      taskId, taskType, assetId, bookId, meta,
      resultUrls, resultObject,
    } = payload as CompleteProviderTaskPayload;

    // Pattern C: inherit the provider lease via getOwner, abort if the row
    // already terminated, and register the lease so the wrapper's catch path
    // CAS-fails by task_id (unaffected by a fresh retry on the same asset).
    const ownerId = await fs.jobs.pending.getOwner(assetId, taskId);
    if (!ownerId) {
      // The row was already removed by a fail/delete or a stale duplicate
      // dispatch. Either way the task is no longer ours to complete.
      return { success: true, skipped: true };
    }
    ctx.setLease({ kind: "task", taskId });

    const completionFamily = completionFamilyForTaskType(taskType);
    if (!completionFamily) {
      throw new Error(`Unhandled provider task type: ${taskType}`);
    }

    // Resolve the asset directory at runtime so renames don't break completion.
    const assetDirResult = await fs.workspaces.resolveArtifact(assetId);
    if (!assetDirResult.ok) {
      await fs.jobs.pending.delete(assetId, taskId);
      return { success: true, skipped: true };
    }
    const assetDir = assetDirResult.value;

    const lockState = taskType === "isolate_vocals" ? "isolating" : "generating";
    const lockResult = await fs.jobs.locks.acquire(assetDir, { durationMs: LOCK_DURATION_MS, data: { state: lockState } });
    if (!lockResult.ok) {
      // LOCKED means another completion job for this same asset is already
      // running (sync can enqueue duplicates between polls because
      // the provider task remains pending until the completion job finishes).
      // Treat as a no-op — the other job will finish the work.
      if (lockResult.error.code === "LOCKED") {
        return { success: true, skipped: true };
      }
      throw new Error(`Asset is locked: ${lockResult.error.message}`);
    }

    // Renew the provider lease while we work — covers downloads + processing.
    const heartbeat = setInterval(() => {
      try {
        fs.jobs.artifactWork.renew(assetId, ownerId, 60_000);
      } catch (error) {
        console.warn(`[heartbeat] renew failed for ${assetId}:`, error);
      }
    }, 20_000);

    const urls = taskType.startsWith("fal_")
      ? extractFalUrls(taskType, resultObject)
      : resultUrls;

    try {
      switch (completionFamily) {
        case "nanoBananaImage":
          await completeNanoBananaImage(fs, assetId, bookId, meta, urls, taskType);
          break;
        case "qwenImage":
          await completeQwen2ImageEdit(fs, assetId, bookId, meta, urls, taskType);
          break;
        case "seedreamImage":
          await completeSeedreamImage(
            fs,
            assetId,
            bookId,
            meta,
            urls,
            taskType as "seedream_text_image" | "seedream_image",
          );
          break;
        case "seedreamV5Image":
          await completeSeedreamV5LiteImage(fs, assetId, bookId, meta, urls, taskType);
          break;
        case "klingVideo":
          await completeKling30Video(fs, assetId, assetDir, bookId, meta, urls, taskType);
          break;
        case "providerVideo":
          await completeProviderVideo(
            fs,
            assetId,
            assetDir,
            bookId,
            meta,
            urls,
            taskType === "seedance2_video" ? taskId : undefined,
          );
          break;
        case "grokVideo":
          await completeGrokImagineVideo(fs, assetId, assetDir, bookId, meta, urls, taskType, taskId);
          break;
        case "wanVideo":
          await completeWan27Video(fs, assetId, assetDir, bookId, meta, urls, taskId);
          break;
        case "happyHorseVideo":
          await completeHappyHorseVideo(fs, assetId, assetDir, bookId, meta, urls, taskType, taskId);
          break;
        case "miniMaxVideo":
          await completeMiniMaxH3Video(fs, assetId, assetDir, bookId, meta, urls, taskType, taskId);
          break;
        case "lipSyncVideo":
          await completeVolcengineLipSyncVideo(fs, assetId, assetDir, bookId, meta, urls, taskId);
          break;
        case "omnihumanVideo":
          await completeOmnihumanVideo(fs, assetId, assetDir, bookId, meta, urls, taskId);
          break;
        case "wanImage": {
          const variant = taskType === "wan27_image_pro"
            || taskType === "fal_wan27_pro"
            || taskType === "fal_wan27_pro_edit"
            ? "wan27_image_pro"
            : "wan27_image";
          await completeWan27Image(fs, assetId, bookId, meta, urls, variant);
          break;
        }
        case "alibabaVideo":
          await completeAlibabaVideo(fs, assetId, assetDir, bookId, meta, urls, taskId);
          break;
        case "alibabaImage":
          await completeAlibabaImage(
            fs,
            assetId,
            bookId,
            meta,
            urls,
            taskType as "alibaba_image" | "alibaba_image_pro",
          );
          break;
        case "alibabaQwenImage":
          await completeAlibabaQwenImage(
            fs,
            assetId,
            bookId,
            meta,
            urls,
            taskType as "alibaba_qwen_image" | "alibaba_qwen_image_edit",
          );
          break;
        case "grokImage":
          await completeGrokImagineImage(fs, assetId, bookId, meta, urls);
          break;
        case "gptImage":
          await completeGptImage(
            fs,
            assetId,
            bookId,
            meta,
            urls,
            taskType as "gpt_image" | "gpt_image_text",
          );
          break;
        case "isolateVocals":
          await completeIsolateVocals(fs, assetId, meta, urls);
          break;
        default: {
          const unhandledFamily: never = completionFamily;
          throw new Error(`Unhandled provider completion family: ${unhandledFamily}`);
        }
      }

      await fs.jobs.pending.delete(assetId, taskId);
      return { success: true };
    } finally {
      clearInterval(heartbeat);
      await fs.jobs.locks.release(assetDir);
    }
  });
}

const FAL_VIDEO_TASK_PREFIXES = [
  "fal_seedance2_",
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

async function completeSeedreamImage(
  fs: Engine,
  assetId: string,
  bookId: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
  taskType: "seedream_text_image" | "seedream_image",
): Promise<void> {
  const imageUrl = resultUrls[0];
  if (!imageUrl) throw new Error("No image URL in result");

  const buffer = await downloadUrlIntoAsset(fs, imageUrl, assetId, "original.png", { kind: "image" });

  const origin = {
    source_assets: meta.sourceImageIds,
    model: taskType === "seedream_image"
      ? "seedream/5-lite-image-to-image"
      : "seedream/5-lite-text-to-image",
    prompt: meta.prompt,
    download_url: imageUrl,
    download_url_content_hash: contentHash(buffer),
    ...(meta.aspectRatio !== undefined ? { aspect_ratio: meta.aspectRatio } : {}),
    ...(meta.quality !== undefined ? { quality: meta.quality } : {}),
    ...(meta.nsfwChecker !== undefined ? { nsfw_checker: meta.nsfwChecker } : {}),
    generated_at: new Date().toISOString(),
  };
  const jobId = `process-image-${assetId}-${Date.now()}`;
  await queue.enqueue(jobId, {
    type: "process_image",
    assetId,
    bookId,
    extension: ".png",
    provenance: origin,
  } as unknown as Record<string, unknown>);
}

async function completeSeedreamV5LiteImage(
  fs: Engine,
  assetId: string,
  bookId: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
  taskType: string,
): Promise<void> {
  const imageUrl = resultUrls[0];
  if (!imageUrl) throw new Error("No image URL in result");

  const buffer = await downloadUrlIntoAsset(fs, imageUrl, assetId, "original.png", { kind: "image" });

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
    bookId,
    extension: ".png",
    provenance: origin,
  } as unknown as Record<string, unknown>);
}

async function completeNanoBananaImage(
  fs: Engine,
  assetId: string,
  bookId: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
  taskType: string,
): Promise<void> {
  const imageUrl = resultUrls[0];
  if (!imageUrl) throw new Error("No image URL in result");

  const ext = (meta.outputFormat as string) ?? "png";
  const buffer = await downloadUrlIntoAsset(fs, imageUrl, assetId, `original.${ext}`, { kind: "image" });

  let model = "nano-banana-pro";
  if (taskType.includes("banana_2_lite")) {
    model = "nano-banana-2-lite";
  } else if (taskType.includes("banana_2")) {
    model = "nano-banana-2";
  } else if (taskType.includes("banana_pro")) {
    model = "nano-banana-pro";
  } else if (taskType.includes("banana")) {
    model = "nano-banana";
  }

  const origin = {
    source_assets: meta.sourceImageIds,
    model,
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
    bookId,
    extension: `.${ext}`,
    provenance: origin,
  } as unknown as Record<string, unknown>);
}

async function completeWan27Image(
  fs: Engine,
  assetId: string,
  bookId: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
  taskType: string,
): Promise<void> {
  const imageUrl = resultUrls[0];
  if (!imageUrl) throw new Error("No image URL in result");

  const buffer = await downloadUrlIntoAsset(fs, imageUrl, assetId, "original.png", { kind: "image" });

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
    bookId,
    extension: ".png",
    provenance: origin,
  } as unknown as Record<string, unknown>);
}

async function completeQwen2ImageEdit(
  fs: Engine,
  assetId: string,
  bookId: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
  taskType?: string,
): Promise<void> {
  const imageUrl = resultUrls[0];
  if (!imageUrl) throw new Error("No image URL in result");

  const ext = (meta.outputFormat as string) ?? "png";
  const buffer = await downloadUrlIntoAsset(fs, imageUrl, assetId, `original.${ext}`, { kind: "image" });

  const model =
    taskType === "fal_qwen_image" ? "qwen2/text-to-image" : "qwen2/image-edit";

  const origin = {
    source_assets: meta.sourceImageIds,
    model,
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
    bookId,
    extension: `.${ext}`,
    provenance: origin,
  } as unknown as Record<string, unknown>);
}

async function completeKling30Video(
  fs: Engine,
  assetId: string,
  assetDir: string,
  bookId: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
  taskType?: string,
): Promise<void> {
  const videoUrl = resultUrls[0];
  if (!videoUrl) throw new Error("No video URL in result");

  const buffer = await downloadUrlIntoAsset(fs, videoUrl, assetId, "original.mp4", { kind: "video" });

  const provenance = {
    source_assets: meta.sourceImageIds,
    source_videos: meta.sourceVideoIds,
    model: taskType === "kling30_motion_control_video" ? "kling-3.0/motion-control" : "kling-3.0/video",
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
    bookId,
    provenance,
  } as unknown as Record<string, unknown>);
}

async function completeProviderVideo(
  fs: Engine,
  assetId: string,
  assetDir: string,
  bookId: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
  kieTaskId?: string,
): Promise<void> {
  const videoUrl = resultUrls[0];
  if (!videoUrl) throw new Error("No video URL in result");

  const outputFormat = meta.output_format === "mov" ? "mov" : "mp4";
  const originalFilename = `original.${outputFormat}`;
  const buffer = await downloadUrlIntoAsset(fs, videoUrl, assetId, originalFilename, { kind: "video" });

  // Optionally save the returned last frame as a secondary image file
  if (meta.return_last_frame === true && resultUrls[1]) {
    const frameResponse = await fetch(resultUrls[1]);
    if (frameResponse.ok) {
      const frameBuffer = Buffer.from(await frameResponse.arrayBuffer());
      await fs.files.write(assetId, "last_frame.png", frameBuffer);
    }
  }

  const provenance = {
    source_images: meta.sourceImageIds,
    source_videos: meta.sourceVideoIds,
    source_audios: meta.sourceAudioIds,
    model: typeof meta.apiModel === "string" ? meta.apiModel : "bytedance/seedance-2-fast",
    download_url: videoUrl,
    download_url_content_hash: contentHash(buffer),
    ...(meta.mode !== undefined ? { seedance_mode: meta.mode } : {}),
    ...(meta.prompt !== undefined ? { prompt: meta.prompt } : {}),
    ...(meta.output_format !== undefined ? { output_format: meta.output_format } : {}),
    generated_at: new Date().toISOString(),
  };

  const videoPath = join(assetDir, originalFilename);

  if (kieTaskId !== undefined) {
    await fs.metadata.artifacts.write(assetId, "kie-task-id", { taskId: kieTaskId });
  }

  // When the caller asked us to splice a specific audio over the seedance
  // output (PlanViewer's per-scene `plan/sN.mp3` flow), enqueue
  // replace_video_audio instead of process_video — that job handles the splice
  // and chains process_video itself. Doing this server-side means the asset
  // only flips to 'ready' AFTER the splice, so a page reload between RUN
  // VIDEO and seedance completion can no longer drop the audio replacement.
  const replaceAudioWith = meta.replaceAudioWith as { assetId: string; filename: string } | undefined;
  if (replaceAudioWith) {
    const audioManifest = await fs.files.manifest(replaceAudioWith.assetId);
    if (!audioManifest.ok) {
      throw new Error(`replaceAudioWith asset not found: ${audioManifest.error.message}`);
    }
    const audioPath = join(audioManifest.value.path, replaceAudioWith.filename);
    const audioAssetId = `${replaceAudioWith.assetId}/${replaceAudioWith.filename}`;
    await queue.enqueue(`replace-audio-${assetId}-${Date.now()}`, {
      type: "replace_video_audio",
      inputPath: videoPath,
      audioPath,
      outputPath: join(assetDir, "original_audio_replaced.mp4"),
      assetId,
      assetDir,
      audioAssetId,
      bookId,
      extraProvenance: provenance,
    } as unknown as Record<string, unknown>);
    return;
  }

  const jobId = `process-video-${assetId}-${Date.now()}`;
  await queue.enqueue(jobId, {
    type: "process_video",
    videoPath,
    assetId,
    assetDir,
    bookId,
    provenance,
  } as unknown as Record<string, unknown>);
}

async function completeWan27Video(
  fs: Engine,
  assetId: string,
  assetDir: string,
  bookId: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
  taskId?: string,
): Promise<void> {
  const videoUrl = resultUrls[0];
  if (!videoUrl) throw new Error("No video URL in result");

  const buffer = await downloadUrlIntoAsset(fs, videoUrl, assetId, "original.mp4", { kind: "video" });

  const wan27Model =
    meta.mode === "reference" ? "wan/2-7-r2v"
      : meta.mode === "videoedit" ? "wan/2-7-videoedit"
      : meta.mode === "t2v" ? "wan/2-7-text-to-video"
      : "wan/2-7-image-to-video";
  const provenance = {
    source_images: meta.sourceImageIds,
    source_videos: meta.sourceVideoIds,
    source_audios: meta.sourceAudioIds,
    model: wan27Model,
    download_url: videoUrl,
    download_url_content_hash: contentHash(buffer),
    ...(meta.prompt !== undefined ? { prompt: meta.prompt } : {}),
    generated_at: new Date().toISOString(),
  };

  const videoPath = join(assetDir, "original.mp4");

  if (taskId !== undefined) {
    await fs.metadata.artifacts.write(assetId, "kie-task-id", { taskId });
  }

  const jobId = `process-video-${assetId}-${Date.now()}`;
  await queue.enqueue(jobId, {
    type: "process_video",
    videoPath,
    assetId,
    assetDir,
    bookId,
    provenance,
  } as unknown as Record<string, unknown>);
}

async function completeVolcengineLipSyncVideo(
  fs: Engine,
  assetId: string,
  assetDir: string,
  bookId: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
  taskId?: string,
): Promise<void> {
  const videoUrl = resultUrls[0];
  if (!videoUrl) throw new Error("No video URL in result");

  const buffer = await downloadUrlIntoAsset(fs, videoUrl, assetId, "original.mp4", { kind: "video" });

  const provenance = {
    source_images: meta.sourceImageIds,
    source_videos: meta.sourceVideoIds,
    source_audios: meta.sourceAudioIds,
    model: "volcengine/video-to-video-lip-sync",
    download_url: videoUrl,
    download_url_content_hash: contentHash(buffer),
    generated_at: new Date().toISOString(),
  };

  const videoPath = join(assetDir, "original.mp4");

  if (taskId !== undefined) {
    await fs.metadata.artifacts.write(assetId, "kie-task-id", { taskId });
  }

  const jobId = `process-video-${assetId}-${Date.now()}`;
  await queue.enqueue(jobId, {
    type: "process_video",
    videoPath,
    assetId,
    assetDir,
    bookId,
    provenance,
  } as unknown as Record<string, unknown>);
}

async function completeOmnihumanVideo(
  fs: Engine,
  assetId: string,
  assetDir: string,
  bookId: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
  taskId?: string,
): Promise<void> {
  const videoUrl = resultUrls[0];
  if (!videoUrl) throw new Error("No video URL in result");

  const buffer = await downloadUrlIntoAsset(fs, videoUrl, assetId, "original.mp4", { kind: "video" });

  const provenance = {
    source_images: meta.sourceImageIds,
    source_videos: meta.sourceVideoIds,
    source_audios: meta.sourceAudioIds,
    model: "omnihuman-1-5",
    download_url: videoUrl,
    download_url_content_hash: contentHash(buffer),
    ...(meta.prompt !== undefined ? { prompt: meta.prompt } : {}),
    generated_at: new Date().toISOString(),
  };

  const videoPath = join(assetDir, "original.mp4");

  if (taskId !== undefined) {
    await fs.metadata.artifacts.write(assetId, "kie-task-id", { taskId });
  }

  const jobId = `process-video-${assetId}-${Date.now()}`;
  await queue.enqueue(jobId, {
    type: "process_video",
    videoPath,
    assetId,
    assetDir,
    bookId,
    provenance,
  } as unknown as Record<string, unknown>);
}

async function completeGrokImagineVideo(
  fs: Engine,
  assetId: string,
  assetDir: string,
  bookId: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
  taskType: string,
  taskId?: string,
): Promise<void> {
  const videoUrl = resultUrls[0];
  if (!videoUrl) throw new Error("No video URL in result");

  const buffer = await downloadUrlIntoAsset(fs, videoUrl, assetId, "original.mp4", { kind: "video" });

  const provenance = {
    source_asset: meta.sourceVideoId ?? meta.sourceImageId,
    model: meta.upscale === true
      ? "grok-imagine/video-upscale"
      : taskType === "grok_imagine_t2v_video"
        ? "grok-imagine/text-to-video"
        : taskType === "grok_imagine_video"
          ? "grok-imagine/image-to-video"
        : meta.sourceVideoId
          ? "grok-imagine/video-extension"
          : "grok-imagine/image-to-video",
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
    await fs.metadata.artifacts.write(assetId, "kie-task-id", { taskId });
  }

  const replaceAudioWith = meta.replaceAudioWith as { assetId: string; filename: string } | undefined;
  if (replaceAudioWith) {
    const audioManifest = await fs.files.manifest(replaceAudioWith.assetId);
    if (!audioManifest.ok) {
      throw new Error(`replaceAudioWith asset not found: ${audioManifest.error.message}`);
    }
    const audioPath = join(audioManifest.value.path, replaceAudioWith.filename);
    const audioAssetId = `${replaceAudioWith.assetId}/${replaceAudioWith.filename}`;
    await queue.enqueue(`replace-audio-${assetId}-${Date.now()}`, {
      type: "replace_video_audio",
      inputPath: videoPath,
      audioPath,
      outputPath: join(assetDir, "original_audio_replaced.mp4"),
      assetId,
      assetDir,
      audioAssetId,
      bookId,
      extraProvenance: provenance,
    } as unknown as Record<string, unknown>);
    return;
  }

  const jobId = `process-video-${assetId}-${Date.now()}`;
  await queue.enqueue(jobId, {
    type: "process_video",
    videoPath,
    assetId,
    assetDir,
    bookId,
    provenance,
  } as unknown as Record<string, unknown>);
}

async function completeGrokImagineImage(
  fs: Engine,
  assetId: string,
  bookId: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
): Promise<void> {
  const imageUrl = resultUrls[0];
  if (!imageUrl) throw new Error("No image URL in result");

  const buffer = await downloadUrlIntoAsset(fs, imageUrl, assetId, "original.png", { kind: "image" });

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
    bookId,
    extension: ".png",
    provenance: origin,
  } as unknown as Record<string, unknown>);
}

async function completeGptImage(
  fs: Engine,
  assetId: string,
  bookId: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
  taskType: "gpt_image" | "gpt_image_text",
): Promise<void> {
  const imageUrl = resultUrls[0];
  if (!imageUrl) throw new Error("No image URL in result");

  const buffer = await downloadUrlIntoAsset(fs, imageUrl, assetId, "original.png", { kind: "image" });

  const origin = {
    source_assets: meta.sourceImageIds,
    model: taskType === "gpt_image_text" ? "gpt-image-2-text-to-image" : "gpt-image-2-image-to-image",
    prompt: meta.prompt,
    download_url: imageUrl,
    download_url_content_hash: contentHash(buffer),
    ...(meta.aspectRatio !== undefined ? { aspect_ratio: meta.aspectRatio } : {}),
    ...(meta.nsfwChecker !== undefined ? { nsfw_checker: meta.nsfwChecker } : {}),
    generated_at: new Date().toISOString(),
  };
  const jobId = `process-image-${assetId}-${Date.now()}`;
  await queue.enqueue(jobId, {
    type: "process_image",
    assetId,
    bookId,
    extension: ".png",
    provenance: origin,
  } as unknown as Record<string, unknown>);
}

async function completeIsolateVocals(
  fs: Engine,
  assetId: string,
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
    await fs.files.write(assetId, "mix.mp3", vocalsBuffer);
    const mixSettings = { volume: 100, fadeIn: 0, fadeOut: 0 };
    await fs.files.write(assetId, ".mix.json", JSON.stringify(mixSettings, null, 2));
  } else {
    // Video assets: write audio_vocals.mp3
    await fs.files.write(assetId, "audio_vocals.mp3", vocalsBuffer);

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
        await fs.files.write(assetId, "audio_background.mp3", bgBuffer);
      }
    }
  }

  await fs.history.recordOperation("isolate_vocals", assetId, { mode: "cloud" });
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
  fs: Engine,
  assetId: string,
): Promise<string | undefined> {
  const result = await fs.metadata.artifacts.read<{ model?: string }>(assetId, "generation-payload");
  if (!result.ok) return undefined;
  return typeof result.value.model === "string" ? result.value.model : undefined;
}

async function completeAlibabaVideo(
  fs: Engine,
  assetId: string,
  assetDir: string,
  bookId: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
  taskId?: string,
): Promise<void> {
  const videoUrl = resultUrls[0];
  if (!videoUrl) throw new Error("No video URL in Alibaba result");

  const buffer = await downloadUrlIntoAsset(fs, videoUrl, assetId, "original.mp4", { kind: "video" });

  const modelName = (await readPayloadModel(fs, assetId)) ?? "alibaba/wan2.7-video";

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
    await fs.metadata.artifacts.write(assetId, "alibaba-task-id", { taskId });
  }

  const videoPath = join(assetDir, "original.mp4");
  const jobId = `process-video-${assetId}-${Date.now()}`;
  await queue.enqueue(jobId, {
    type: "process_video",
    videoPath,
    assetId,
    assetDir,
    bookId,
    provenance,
  } as unknown as Record<string, unknown>);
}

async function completeAlibabaQwenImage(
  fs: Engine,
  assetId: string,
  bookId: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
  taskType: "alibaba_qwen_image" | "alibaba_qwen_image_edit",
): Promise<void> {
  const imageUrl = resultUrls[0];
  if (!imageUrl) throw new Error("No image URL in Alibaba Qwen result");

  const ext = extensionFromUrl(imageUrl, "png");
  const buffer = await downloadUrlIntoAsset(fs, imageUrl, assetId, `original.${ext}`, { kind: "image" });

  const fallbackModel = taskType === "alibaba_qwen_image_edit"
    ? "alibaba/qwen-image-edit-plus"
    : "alibaba/qwen-image-2.0-pro";
  const modelName = (await readPayloadModel(fs, assetId))
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
    bookId,
    extension: `.${ext}`,
    provenance: origin,
  } as unknown as Record<string, unknown>);
}

async function completeHappyHorseVideo(
  fs: Engine,
  assetId: string,
  assetDir: string,
  bookId: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
  taskType: string,
  taskId?: string,
): Promise<void> {
  const videoUrl = resultUrls[0];
  if (!videoUrl) throw new Error("No video URL in result");

  const buffer = await downloadUrlIntoAsset(fs, videoUrl, assetId, "original.mp4", { kind: "video" });

  // t2v/i2v/ref generate against HappyHorse 1.1; video-edit has no 1.1 endpoint
  // and stays on 1.0. This string is descriptive provenance only (never fed to
  // modelSlug/pricing), so the 1.1 keys are safe to record.
  const happyhorseModel =
    taskType === "happyhorse_t2v_video" ? "happyhorse-1-1/text-to-video"
      : taskType === "happyhorse_i2v_video" ? "happyhorse-1-1/image-to-video"
      : taskType === "happyhorse_ref_video" ? "happyhorse-1-1/reference-to-video"
      : "happyhorse/video-edit";
  const provenance = {
    source_images: meta.sourceImageIds,
    source_videos: meta.sourceVideoIds,
    source_audios: meta.sourceAudioIds,
    model: happyhorseModel,
    download_url: videoUrl,
    download_url_content_hash: contentHash(buffer),
    ...(meta.prompt !== undefined ? { prompt: meta.prompt } : {}),
    generated_at: new Date().toISOString(),
  };

  const videoPath = join(assetDir, "original.mp4");

  if (taskId !== undefined) {
    await fs.metadata.artifacts.write(assetId, "kie-task-id", { taskId });
  }

  const jobId = `process-video-${assetId}-${Date.now()}`;
  await queue.enqueue(jobId, {
    type: "process_video",
    videoPath,
    assetId,
    assetDir,
    bookId,
    provenance,
  } as unknown as Record<string, unknown>);
}

async function completeMiniMaxH3Video(
  fs: Engine,
  assetId: string,
  assetDir: string,
  bookId: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
  taskType: string,
  taskId?: string,
): Promise<void> {
  const videoUrl = resultUrls[0];
  if (!videoUrl) throw new Error("No video URL in result");

  const buffer = await downloadUrlIntoAsset(fs, videoUrl, assetId, "original.mp4", { kind: "video" });

  // Descriptive provenance only (never fed to modelSlug/pricing).
  const minimaxModel =
    taskType === "minimax_h3_t2v_video" ? "minimax-h3/text-to-video"
      : taskType === "minimax_h3_i2v_video" ? "minimax-h3/image-to-video"
      : "minimax-h3/reference-to-video";
  const provenance = {
    source_images: meta.sourceImageIds,
    source_videos: meta.sourceVideoIds,
    source_audios: meta.sourceAudioIds,
    model: minimaxModel,
    download_url: videoUrl,
    download_url_content_hash: contentHash(buffer),
    ...(meta.prompt !== undefined ? { prompt: meta.prompt } : {}),
    generated_at: new Date().toISOString(),
  };

  const videoPath = join(assetDir, "original.mp4");

  if (taskId !== undefined) {
    await fs.metadata.artifacts.write(assetId, "kie-task-id", { taskId });
  }

  const jobId = `process-video-${assetId}-${Date.now()}`;
  await queue.enqueue(jobId, {
    type: "process_video",
    videoPath,
    assetId,
    assetDir,
    bookId,
    provenance,
  } as unknown as Record<string, unknown>);
}

async function completeAlibabaImage(
  fs: Engine,
  assetId: string,
  bookId: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
  taskType: "alibaba_image" | "alibaba_image_pro",
): Promise<void> {
  const imageUrl = resultUrls[0];
  if (!imageUrl) throw new Error("No image URL in Alibaba result");

  const ext = extensionFromUrl(imageUrl, "png");
  const buffer = await downloadUrlIntoAsset(fs, imageUrl, assetId, `original.${ext}`, { kind: "image" });

  const modelName = (await readPayloadModel(fs, assetId))
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
    bookId,
    extension: `.${ext}`,
    provenance: origin,
  } as unknown as Record<string, unknown>);
}

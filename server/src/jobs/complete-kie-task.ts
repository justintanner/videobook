import type { ClipfirstFs } from "clipfirst-fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFile, unlink, readFile as readFsFile } from "node:fs/promises";
import { queue, registerJobHandler } from "../queue.js";
import { findVideoFile } from "../media-files.js";
import { runFfmpeg } from "../ffmpeg.js";
import { deletePendingTask } from "./pending-task.js";
import { readStoredRenderDefaults, readAnalysisRecommendations } from "../tools/sync.js";

const LOCK_DURATION_MS = 300_000;

type CompleteKieTaskPayload = {
  type: "complete_kie_task";
  taskId: string;
  taskType: "nano_banana_image" | "qwen2_image_edit" | "grok_imagine_video" | "grok_imagine_image" | "grok_imagine_text" | "gpt_image" | "kling30_video" | "seedance2_video" | "wan27_i2v_video" | "wan27_videoedit_video" | "wan27_r2v_video" | "wan27_image" | "wan27_image_pro" | "transcribe" | "isolate_vocals" | "xai_grok_imagine_video" | "xai_grok_imagine_ref_video" | "xai_grok_imagine_extend_video" | "grok_imagine_extend_video";
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
      taskId, taskType, assetId, assetDir, projectSlug, meta,
      resultUrls, resultObject,
    } = payload as CompleteKieTaskPayload;

    const lockResult = await fs.acquireLock(assetDir, { durationMs: LOCK_DURATION_MS, data: { state: "generating" } });
    if (!lockResult.ok) throw new Error(`Asset is locked: ${lockResult.error.message}`);

    try {
      if (taskType === "nano_banana_image") {
        await completeNanoBananaImage(fs, assetId, projectSlug, meta, resultUrls);
      } else if (taskType === "qwen2_image_edit") {
        await completeQwen2ImageEdit(fs, assetId, projectSlug, meta, resultUrls);
      } else if (taskType === "kling30_video") {
        await completeKling30Video(fs, assetId, assetDir, projectSlug, meta, resultUrls);
      } else if (taskType === "seedance2_video") {
        await completeSeedance2Video(fs, assetId, assetDir, projectSlug, meta, resultUrls, taskId);
      } else if (taskType === "grok_imagine_video" || taskType === "xai_grok_imagine_video" || taskType === "xai_grok_imagine_ref_video" || taskType === "xai_grok_imagine_extend_video" || taskType === "grok_imagine_extend_video") {
        await completeGrokImagineVideo(fs, assetId, assetDir, projectSlug, meta, resultUrls, taskType, taskId);
      } else if (taskType === "wan27_i2v_video" || taskType === "wan27_videoedit_video" || taskType === "wan27_r2v_video") {
        await completeWan27Video(fs, assetId, assetDir, projectSlug, meta, resultUrls, taskId);
      } else if (taskType === "wan27_image" || taskType === "wan27_image_pro") {
        await completeWan27Image(fs, assetId, projectSlug, meta, resultUrls, taskType);
      } else if (taskType === "grok_imagine_image" || taskType === "grok_imagine_text") {
        await completeGrokImagineImage(fs, assetId, projectSlug, meta, resultUrls);
      } else if (taskType === "gpt_image") {
        await completeGptImage(fs, assetId, projectSlug, meta, resultUrls);
      } else if (taskType === "transcribe") {
        await completeTranscribe(fs, assetId, assetDir, projectSlug, meta, resultObject);
      } else if (taskType === "isolate_vocals") {
        await completeIsolateVocals(fs, assetId, projectSlug, meta, resultUrls);
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
    source_asset: meta.sourceImageId,
    model: "qwen2/image-edit",
    prompt: meta.prompt,
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

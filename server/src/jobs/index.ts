import type { ClipfirstFs } from "clipfirst-fs";
import { registerTranscribeJob } from "./transcribe.js";
import { registerDownloadVideoJob } from "./download-video.js";
import { registerTrimVideoJob } from "./trim-video.js";
import { registerChangeVideoSpeedJob } from "./change-video-speed.js";
import { registerReverseVideoJob } from "./reverse-video.js";
import { registerExtractFrameJob } from "./extract-frame.js";
import { registerExtractAudioJob } from "./extract-audio.js";
import { registerGenerateGrokImagineVideoJob } from "./generate-grok-imagine-video.js";
import { registerGenerateNanoBananaImageJob } from "./generate-nano-banana-image.js";
import { registerGenerateGrokImagineImageJob } from "./generate-grok-imagine-image.js";
import { registerGenerateGptImageJob } from "./generate-gpt-image.js";
import { registerCompleteKieTaskJob } from "./complete-kie-task.js";
import { registerRenderVideoJob } from "./render-video.js";
import { registerProcessVideoJob } from "./process-video.js";
import { registerTranscribeVideoAudioJob } from "./transcribe-video-audio.js";
import { registerAnalyzeVideoJob } from "./analyze-video.js";

export function registerAllJobHandlers(fs: ClipfirstFs): void {
  registerTranscribeJob(fs);
  registerDownloadVideoJob(fs);
  registerTrimVideoJob(fs);
  registerChangeVideoSpeedJob(fs);
  registerReverseVideoJob(fs);
  registerExtractFrameJob(fs);
  registerExtractAudioJob(fs);
  registerGenerateGrokImagineVideoJob(fs);
  registerGenerateNanoBananaImageJob(fs);
  registerGenerateGrokImagineImageJob(fs);
  registerGenerateGptImageJob(fs);
  registerCompleteKieTaskJob(fs);
  registerRenderVideoJob(fs);
  registerProcessVideoJob(fs);
  registerTranscribeVideoAudioJob(fs);
  registerAnalyzeVideoJob(fs);
}

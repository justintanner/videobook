import type { ClipfirstFs } from "clipfirst-fs";
import { registerTranscribeJob } from "./transcribe.js";
import { registerDownloadVideoJob } from "./download-video.js";
import { registerTrimVideoJob } from "./trim-video.js";
import { registerChangeVideoSpeedJob } from "./change-video-speed.js";
import { registerReverseVideoJob } from "./reverse-video.js";
import { registerExtractFrameJob } from "./extract-frame.js";
import { registerExtractAudioJob } from "./extract-audio.js";
import { registerGenerateGrokImagineVideoJob } from "./generate-grok-imagine-video.js";

export function registerAllJobHandlers(fs: ClipfirstFs): void {
  registerTranscribeJob(fs);
  registerDownloadVideoJob(fs);
  registerTrimVideoJob(fs);
  registerChangeVideoSpeedJob(fs);
  registerReverseVideoJob(fs);
  registerExtractFrameJob(fs);
  registerExtractAudioJob(fs);
  registerGenerateGrokImagineVideoJob(fs);
}

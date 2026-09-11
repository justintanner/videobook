import { extname } from "node:path";
import { AUDIO_OPTS } from "./ffmpeg.js";

export function audioOnlyOutputOptions(outputPath: string): string[] {
  switch (extname(outputPath).toLowerCase()) {
    case ".mp3":
      return ["-c:a", "libmp3lame", "-q:a", "2", "-ac", "2"];
    case ".wav":
      return ["-c:a", "pcm_s16le", "-ac", "2"];
    case ".ogg":
      return ["-c:a", "libvorbis", "-q:a", "5", "-ac", "2"];
    case ".flac":
      return ["-c:a", "flac", "-compression_level", "5", "-ac", "2"];
    case ".webm":
    case ".opus":
      return ["-c:a", "libopus", "-b:a", "160k", "-ac", "2"];
    case ".weba":
      return ["-f", "webm", "-c:a", "libopus", "-b:a", "160k", "-ac", "2"];
    case ".aac":
    case ".m4a":
      return AUDIO_OPTS;
    default:
      throw new Error(`Unsupported target audio format: ${extname(outputPath) || "unknown"}`);
  }
}

export function videoAudioOutputOptions(outputPath: string): string[] {
  const extension = extname(outputPath).toLowerCase();
  if (extension === ".webm") return ["-c:a", "libopus", "-b:a", "160k", "-ac", "2"];
  if (extension === ".avi") return ["-c:a", "libmp3lame", "-b:a", "192k", "-ac", "2"];
  return AUDIO_OPTS;
}

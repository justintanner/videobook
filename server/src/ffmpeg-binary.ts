import { createRequire } from "node:module";
import { binaryRunsOnHost, readBinaryHeader } from "./ffprobe-binary.js";

export function resolveFfmpegPath(
  bundledPath: string | null,
  override: string | undefined,
  hostArch: string,
): string {
  if (override) return override;
  if (!bundledPath) return "ffmpeg";
  const header = readBinaryHeader(bundledPath);
  return header && binaryRunsOnHost(header, hostArch) ? bundledPath : "ffmpeg";
}

const require = createRequire(import.meta.url);

export const FFMPEG: string = resolveFfmpegPath(
  require("ffmpeg-static") as string | null,
  process.env.VIDEOBOOK_FFMPEG_PATH,
  process.arch,
);

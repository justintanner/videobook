import { RenderInternals } from "@remotion/renderer";
import sharp from "sharp";
import { renderWithEncoderFallback } from "./remotion-encoding.js";

type HardwareAcceleration = "if-possible" | "disable";

let hardwareAvailable: Promise<boolean> | undefined;

async function probeHardwareEncoder(): Promise<boolean> {
  const encoder = process.platform === "darwin" ? "h264_videotoolbox" : "h264_nvenc";
  try {
    const input = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#000000" } }).jpeg().toBuffer();
    await RenderInternals.callFf({
      bin: "ffmpeg",
      args: ["-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-i", "pipe:0", "-frames:v", "1", "-c:v", encoder, "-pix_fmt", "yuv420p", "-f", "null", "-"],
      indent: false,
      logLevel: "error",
      binariesDirectory: null,
      cancelSignal: undefined,
      options: { input, timeout: 10_000 },
    });
    return true;
  } catch {
    return false;
  }
}

export async function renderH264WithEncoderFallback<T>(render: (hardwareAcceleration: HardwareAcceleration) => Promise<T>): Promise<T> {
  hardwareAvailable ??= probeHardwareEncoder();
  return await hardwareAvailable ? renderWithEncoderFallback(render) : render("disable");
}

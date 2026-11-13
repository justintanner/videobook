import { RenderInternals } from "@remotion/renderer";
import sharp from "sharp";
import { expect, it } from "vitest";
import { renderH264WithEncoderFallback } from "./remotion-h264.js";
import { testBudget } from "./test-budget.js";

it.each(["first", "cached"])("selects a working H264 encoder before the %s render on this host", async () => {
  const input = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#FF0000" } }).jpeg().toBuffer();
  let calls = 0;
  await renderH264WithEncoderFallback(async (mode) => {
    calls += 1;
    const encoder = mode === "disable" ? "libx264" : process.platform === "darwin" ? "h264_videotoolbox" : "h264_nvenc";
    const encoded = await RenderInternals.callFf({
      bin: "ffmpeg",
      args: ["-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-i", "pipe:0", "-frames:v", "1", "-c:v", encoder, "-pix_fmt", "yuv420p", "-f", "null", "-"],
      indent: false,
      logLevel: "error",
      binariesDirectory: null,
      cancelSignal: undefined,
      options: { input, timeout: testBudget(10_000) },
    });
    expect(encoded.exitCode).toBe(0);
  });
  expect(calls).toBe(1);
});

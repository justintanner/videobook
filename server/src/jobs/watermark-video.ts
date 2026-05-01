import type { ClipfirstFs } from "clipfirst-engine";
import { mkdir, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import sharp from "sharp";
import QRCode from "qrcode";
import { registerJobHandler, queue } from "../queue.js";
import { runFfmpeg, H264_MEDIUM, probeVideo } from "../ffmpeg.js";
import { withLockedLocalLease } from "./_lease.js";

const LOCK_DURATION_MS = 300_000;
const WATERMARK_DURATION_SECS = 2;
const OVERLAY_ALPHA = 0.2;

const QR_SIZE = 240;
const PADDING = 12;
const TEXT_BAND_HEIGHT = 40;
const CARD_WIDTH = QR_SIZE + PADDING * 2;
const CARD_HEIGHT = TEXT_BAND_HEIGHT + QR_SIZE + PADDING * 2;
const OVERLAY_MARGIN = 24;

interface BuildCardArgs {
  url: string;
  label: string;
  outputPath: string;
}

async function buildCardPng({ url, label, outputPath }: BuildCardArgs): Promise<void> {
  const qrBuffer = await QRCode.toBuffer(url, {
    type: "png",
    margin: 0,
    color: { dark: "#000000", light: "#FFFFFF" },
    errorCorrectionLevel: "M",
    width: QR_SIZE,
  });

  const textImage = await sharp({
    text: {
      text: label,
      font: "Helvetica Bold 22",
      width: CARD_WIDTH - PADDING * 2,
      height: TEXT_BAND_HEIGHT,
      align: "center",
      rgba: true,
    },
  })
    .png()
    .toBuffer();

  await sharp({
    create: {
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([
      { input: textImage, top: PADDING, left: PADDING },
      { input: qrBuffer, top: PADDING + TEXT_BAND_HEIGHT, left: PADDING },
    ])
    .png()
    .toFile(outputPath);
}

interface OverlayArgs {
  inputPath: string;
  cardPath: string;
  outputPath: string;
  startSec: number;
  endSec: number;
  hasAudio: boolean;
}

async function overlayWatermark({
  inputPath,
  cardPath,
  outputPath,
  startSec,
  endSec,
  hasAudio,
}: OverlayArgs): Promise<void> {
  const enable = `between(t,${startSec.toFixed(3)},${endSec.toFixed(3)})`;
  const filter =
    `[1:v]format=rgba,colorchannelmixer=aa=${OVERLAY_ALPHA}[card];` +
    `[0:v][card]overlay=x=W-w-${OVERLAY_MARGIN}:y=H-h-${OVERLAY_MARGIN}:enable='${enable}'`;
  const args = [
    "-y",
    "-i", inputPath,
    "-i", cardPath,
    "-filter_complex", filter,
    ...H264_MEDIUM,
  ];
  if (hasAudio) {
    args.push("-c:a", "copy");
  }
  args.push(outputPath);
  await runFfmpeg(args);
}

type WatermarkVideoPayload = {
  type: "watermark_video";
  inputPath: string;
  outputPath: string;
  url: string;
  label: string;
  assetId: string;
  assetDir: string;
  projectSlug: string;
};

export function registerWatermarkVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("watermark_video", async (payload, ctx) => {
    const {
      inputPath, outputPath, url, label,
      assetId, assetDir, projectSlug,
    } = payload as WatermarkVideoPayload;

    const result = await withLockedLocalLease(
      fs,
      projectSlug,
      assetId,
      assetDir,
      ctx,
      "final",
      { durationMs: LOCK_DURATION_MS, data: { state: "watermarking" } },
      async () => {
        const probe = await probeVideo(inputPath);
        const duration = probe.duration;
        if (!Number.isFinite(duration) || duration <= 0) {
          throw new Error(`Cannot determine video duration for ${inputPath}`);
        }
        const startSec = Math.max(0, duration - WATERMARK_DURATION_SECS);
        const endSec = duration;

        const tempDir = join(assetDir, ".watermark_temp");
        await mkdir(tempDir, { recursive: true });
        const cardPath = join(tempDir, "card.png");

        try {
          await buildCardPng({ url, label, outputPath: cardPath });
          await overlayWatermark({
            inputPath,
            cardPath,
            outputPath,
            startSec,
            endSec,
            hasAudio: probe.hasAudio,
          });
        } finally {
          await rm(tempDir, { recursive: true, force: true });
        }

        const inputFilename = basename(inputPath);
        const outputFilename = basename(outputPath);
        await fs.deleteFile(assetId, inputFilename, projectSlug);
        await fs.renameFile(assetId, outputFilename, inputFilename, projectSlug);

        for (const stale of [
          ".original.analysis.json",
          ".analysis.gpt4otrans.json",
          "elevenlabs.json",
          ".kie-task.json",
        ]) {
          await fs.deleteFile(assetId, stale, projectSlug);
        }

        const videoPath = join(assetDir, inputFilename);
        return { videoPath };
      },
      { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
    );

    await queue.enqueue(`process-video-${assetId}-${Date.now()}`, {
      type: "process_video",
      videoPath: result.videoPath,
      assetId,
      assetDir,
      projectSlug,
      provenance: { origin: "watermark", watermarked_at: new Date().toISOString() },
      force: true,
    } as unknown as Record<string, unknown>);

    return { success: true };
  });
}

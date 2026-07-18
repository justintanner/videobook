import type { VideocityFs } from "videocity-engine";
import {
  mkdtemp,
  readFile as readNodeFile,
  rm,
  unlink,
  writeFile as writeNodeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { registerJobHandler } from "../queue.js";
import {
  buildOutroSpec,
} from "../remotion/qr-outro-spec.js";
import type {
  AspectRatio,
  QrOutroOrientation,
} from "../remotion/qr-outro-spec.js";
import { DEFAULT_QR_OUTRO_SOUND_FILENAME } from "../remotion/qr-outro-audio.js";
import { getSharedBundleLocation } from "../remotion/shared-bundle.js";
import { withRemotionCancellation } from "../remotion-cancellation.js";
import { withLockedLocalLease } from "./_lease.js";
import { processVideoFiles } from "./process-video.js";

const LOCK_DURATION_MS = 15 * 60_000;

type QrOutroAssetRef = {
  assetId: string;
  filename: string;
};

type RenderQrOutroPayload = {
  type: "render_qr_outro";
  projectSlug: string;
  assetId: string;
  orientation: QrOutroOrientation;
  qrImages: QrOutroAssetRef[];
  soundEffect: QrOutroAssetRef | null;
  aspectRatio: AspectRatio;
  durationSeconds?: number;
  includeAudio?: boolean;
};

async function stageAssetFile(
  fs: VideocityFs,
  projectSlug: string,
  ref: QrOutroAssetRef,
  bundleDir: string,
  stem: string,
): Promise<{ filename: string; path: string }> {
  const read = await fs.readFile(ref.assetId, ref.filename, projectSlug);
  if (!read.ok) {
    throw new Error(`Failed to read ${ref.assetId}/${ref.filename}: ${read.error.message}`);
  }
  const filename = `${stem}${extname(ref.filename).toLowerCase()}`;
  const path = join(bundleDir, filename);
  await writeNodeFile(path, read.value);
  return { filename, path };
}

function assertWrite(
  operation: string,
  result: Awaited<ReturnType<VideocityFs["writeFile"]>>,
): void {
  if (!result.ok) throw new Error(`${operation}: ${result.error.message}`);
}

export function registerRenderQrOutroJob(fs: VideocityFs): void {
  registerJobHandler("render_qr_outro", async (payload, ctx) => {
    ctx.signal.throwIfAborted();
    const {
      projectSlug,
      assetId,
      orientation,
      qrImages,
      soundEffect,
      aspectRatio,
      durationSeconds,
      includeAudio = true,
    } = payload as RenderQrOutroPayload;

    const outputManifest = await fs.getManifest(assetId, projectSlug);
    if (!outputManifest.ok) {
      throw new Error(`Failed to resolve output asset: ${outputManifest.error.message}`);
    }

    const bundleDir = await getSharedBundleLocation();
    ctx.signal.throwIfAborted();
    const stagedPaths: string[] = [];
    const tempDir = await mkdtemp(join(tmpdir(), "videocity-qr-outro-"));

    try {
      await withLockedLocalLease(
        fs,
        projectSlug,
        assetId,
        outputManifest.value.path,
        ctx,
        "render",
        {
          durationMs: LOCK_DURATION_MS,
          data: { state: `rendering-qr-outro-${orientation}` },
        },
        async () => {
          ctx.signal.throwIfAborted();
          const nonce = `${assetId}-${Date.now()}`;
          const qrSrcs: string[] = [];
          for (let index = 0; index < qrImages.length; index += 1) {
            ctx.signal.throwIfAborted();
            const qr = await stageAssetFile(
              fs,
              projectSlug,
              qrImages[index],
              bundleDir,
              `qr-outro-code-${nonce}-${index}`,
            );
            stagedPaths.push(qr.path);
            qrSrcs.push(qr.filename);
          }

          let audioSrc: string | null = null;
          if (includeAudio && soundEffect) {
            const audio = await stageAssetFile(
              fs,
              projectSlug,
              soundEffect,
              bundleDir,
              `qr-outro-audio-${nonce}`,
            );
            stagedPaths.push(audio.path);
            audioSrc = audio.filename;
          }

          const inputProps = {
            qrSrcs,
            audioSrc,
            aspectRatio,
            durationSeconds: durationSeconds ?? null,
            includeAudio,
          };
          const composition = await selectComposition({
            serveUrl: bundleDir,
            id: "qr-outro",
            inputProps: inputProps as unknown as Record<string, unknown>,
            timeoutInMilliseconds: 60_000,
          });
          ctx.signal.throwIfAborted();
          const tempOutputPath = join(tempDir, "original.mp4");
          await withRemotionCancellation(ctx.signal, (cancelSignal) =>
            renderMedia({
              composition,
              serveUrl: bundleDir,
              codec: "h264",
              audioCodec: "aac",
              muted: !includeAudio,
              outputLocation: tempOutputPath,
              inputProps: inputProps as unknown as Record<string, unknown>,
              videoBitrate: "8M",
              concurrency: 1,
              hardwareAcceleration: "if-possible",
              cancelSignal,
            }),
          );

          const output = await readNodeFile(tempOutputPath);
          assertWrite(
            `Failed to write ${assetId}/original.mp4`,
            await fs.writeFile(assetId, "original.mp4", output, projectSlug),
          );

          const spec = buildOutroSpec(
            aspectRatio,
            qrImages.length,
            durationSeconds,
          );
          const provenance = {
            origin: "create_qr_outro",
            qr_image_slugs: qrImages.map((image) => image.assetId),
            sound_effect_slug: includeAudio ? soundEffect?.assetId ?? null : null,
            sound_effect_source: includeAudio
              ? soundEffect ? "asset" : "bundled_default"
              : "none",
            sound_effect_filename: includeAudio
              ? soundEffect?.filename ?? DEFAULT_QR_OUTRO_SOUND_FILENAME
              : null,
            include_audio: includeAudio,
            aspect_ratio: aspectRatio,
            fps: spec.fps,
            duration_seconds: spec.totalDurationSeconds,
            impact_frames: spec.impacts.map((impact) => impact.frame),
            rendered_at: new Date().toISOString(),
          };
          const metadata = await fs.writeMetadata(
            assetId,
            "qr-outro",
            provenance,
            projectSlug,
          );
          if (!metadata.ok) {
            throw new Error(`Failed to write QR outro metadata: ${metadata.error.message}`);
          }

          await processVideoFiles(
            fs,
            {
              type: "process_video",
              videoPath: join(outputManifest.value.path, "original.mp4"),
              assetId,
              assetDir: outputManifest.value.path,
              projectSlug,
              provenance,
              skipDownstreamJobs: true,
            },
            ctx.signal,
          );

          return { provenance };
        },
        {
          durationMs: LOCK_DURATION_MS,
          waitForActiveMs: 30_000,
          meta: { orientation },
        },
      );

      ctx.signal.throwIfAborted();
      return { success: true, assetId };
    } finally {
      await Promise.all(stagedPaths.map((path) => unlink(path).catch(() => undefined)));
      await rm(tempDir, { recursive: true, force: true });
    }
  });
}

import type { VideocityFs } from "videocity-engine";
import { copyFile, unlink } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { queue, registerJobHandler } from "../queue.js";
import { getSharedBundleLocation } from "../remotion/shared-bundle.js";

export function registerRenderQrOutroJob(fs: VideocityFs): void {
  registerJobHandler("render_qr_outro", async (payload, _ctx) => {
    void _ctx;
    const {
      projectSlug,
      assetId,
      lastFrameSlug,
      qrImageSlugs,
      soundEffectSlug,
      aspectRatio,
    } = payload as {
      type: "render_qr_outro";
      projectSlug: string;
      assetId: string;
      lastFrameSlug: string;
      qrImageSlugs: string[];
      soundEffectSlug?: string;
      aspectRatio: "16:9" | "9:16" | "1:1";
    };

    const bundleDir = await getSharedBundleLocation();
    const toUnlink: string[] = [];

    try {
      // Resolve Frame Image
      const frameManifest = await fs.getManifest(lastFrameSlug, projectSlug);
      if (!frameManifest.ok) throw new Error(`Background error: ${frameManifest.error.message}`);
      const frameFile = frameManifest.value.files.find(f => f.name.match(/\.(png|jpe?g|webp)$/i));
      if (!frameFile) throw new Error(`No image found in ${lastFrameSlug}`);
      const framePath = join(frameManifest.value.path, frameFile.name);
      
      const frameCopyName = `frame-${assetId}-${Date.now()}${basename(framePath).replace(/^[^.]*/, "")}`;
      const frameCopyPath = join(bundleDir, frameCopyName);
      await copyFile(resolve(framePath), frameCopyPath);
      toUnlink.push(frameCopyPath);

      // Resolve QR Images
      const qrSrcs: string[] = [];
      for (const slug of qrImageSlugs) {
        const manifest = await fs.getManifest(slug, projectSlug);
        if (!manifest.ok) throw new Error(`QR image error (${slug}): ${manifest.error.message}`);
        const imgFile = manifest.value.files.find(f => f.name.match(/\.(png|jpe?g|webp)$/i));
        if (!imgFile) throw new Error(`No image found in ${slug}`);
        const imgPath = join(manifest.value.path, imgFile.name);
        
        const qrCopyName = `qr-${assetId}-${Date.now()}-${basename(imgPath).replace(/^[^.]*/, "")}`;
        const qrCopyPath = join(bundleDir, qrCopyName);
        await copyFile(resolve(imgPath), qrCopyPath);
        toUnlink.push(qrCopyPath);
        qrSrcs.push(qrCopyName);
      }

      // Resolve Audio
      let audioCopyName: string | null = null;
      if (soundEffectSlug) {
        const audioManifest = await fs.getManifest(soundEffectSlug, projectSlug);
        if (!audioManifest.ok) throw new Error(`Audio error: ${audioManifest.error.message}`);
        const audioFile = audioManifest.value.files.find(f => f.name.match(/\.(mp3|wav|m4a|aac|ogg)$/i));
        if (!audioFile) throw new Error(`No audio found in ${soundEffectSlug}`);
        const audioPath = join(audioManifest.value.path, audioFile.name);
        
        audioCopyName = `audio-${assetId}-${Date.now()}${basename(audioPath).replace(/^[^.]*/, "")}`;
        const audioCopyPath = join(bundleDir, audioCopyName);
        await copyFile(resolve(audioPath), audioCopyPath);
        toUnlink.push(audioCopyPath);
      }

      const inputProps = {
        frameSrc: frameCopyName,
        qrSrcs,
        audioSrc: audioCopyName,
        aspectRatio,
      };

      const composition = await selectComposition({
        serveUrl: bundleDir,
        id: "qr-outro",
        inputProps: inputProps as unknown as Record<string, unknown>,
      });

      const outputManifest = await fs.getManifest(assetId, projectSlug);
      if (!outputManifest.ok) throw new Error(`Failed to get output asset manifest: ${outputManifest.error.message}`);
      
      const outputPath = join(outputManifest.value.path, "original.mp4");

      await renderMedia({
        composition,
        serveUrl: bundleDir,
        codec: "h264",
        outputLocation: outputPath,
        inputProps: inputProps as unknown as Record<string, unknown>,
        videoBitrate: "8M",
        concurrency: 1,
        hardwareAcceleration: "if-possible",
      });

      await fs.writeMetadata(assetId, "qr-outro", {
        last_frame_slug: lastFrameSlug,
        qr_image_slugs: qrImageSlugs,
        sound_effect_slug: soundEffectSlug,
        aspect_ratio: aspectRatio,
        renderedAt: new Date().toISOString(),
      }, projectSlug);

      // Enqueue process_video job to extract frames, waveforms, etc.
      await queue.enqueue(`process-${assetId}-${Date.now()}`, {
        type: "process_video",
        projectSlug,
        assetId,
        videoPath: outputPath,
        assetDir: outputManifest.value.path,
        provenance: { type: "qr_outro" },
        skipDownstreamJobs: true, // We don't need transcription for the outro
      });

      return { success: true, assetId };
    } finally {
      for (const file of toUnlink) {
        await unlink(file).catch(() => {});
      }
    }
  });
}

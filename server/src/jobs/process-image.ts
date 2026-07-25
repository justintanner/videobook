import type { Engine } from "videobook-engine";
import { queue, registerJobHandler } from "../queue.js";
import { withLocalLease } from "./_lease.js";
import { probeImage, cropToFill } from "../image.js";
import { withTransientStorageRetry } from "./_storage-retry.js";

export const SKIP_CROP_EXTENSIONS = new Set([".svg", ".gif"]);

type ProcessImagePayload = {
  type: "process_image";
  assetId: string;
  bookId: string;
  extension: string;
  provenance: Record<string, unknown>;
};

export function registerProcessImageJob(fs: Engine): void {
  registerJobHandler("process_image", async (payload, ctx) => {
    const {
      assetId, bookId, extension, provenance,
    } = payload as ProcessImagePayload;

    return withLocalLease(fs, bookId, assetId, ctx, "process", async () =>
      withTransientStorageRetry(async () => {
        const readResult = await fs.files.read(assetId, `original${extension}`);
        if (!readResult.ok) throw new Error(`Failed to read original: ${readResult.error.message}`);

        const buffer = Buffer.isBuffer(readResult.value) ? readResult.value : Buffer.from(readResult.value);
        const { width, height } = await probeImage(buffer);

        const metadata = await fs.metadata.artifacts.write(
          assetId,
          "original",
          { ...provenance, width, height },
        );
        if (!metadata.ok) throw new Error(metadata.error.message);

        if (!SKIP_CROP_EXTENSIONS.has(extension)) {
          const [landscape, portrait, square] = await Promise.all([
            cropToFill(buffer, 1920, 1080),
            cropToFill(buffer, 1080, 1920),
            cropToFill(buffer, 1080, 1080),
          ]);

          const landscapeWrite = await fs.files.write(
            assetId,
            "landscape.jpg",
            landscape,
          );
          if (!landscapeWrite.ok) throw new Error(landscapeWrite.error.message);
          const portraitWrite = await fs.files.write(
            assetId,
            "portrait.jpg",
            portrait,
          );
          if (!portraitWrite.ok) throw new Error(portraitWrite.error.message);
          const squareWrite = await fs.files.write(
            assetId,
            "square.jpg",
            square,
          );
          if (!squareWrite.ok) throw new Error(squareWrite.error.message);
        }

        if (process.env.NODE_ENV !== "test") {
          await queue.enqueue(`semantic-index-${assetId}-${Date.now()}`, {
            type: "semantic_index",
            assetId,
            bookId,
          } as unknown as Record<string, unknown>);
        }

        // Vision analysis (describe_image) is gated to slot drop in
        // tools/assign-slot.ts so we don't burn Gemini analysis on uploads that never
        // land in the timeline.
        return { success: true, width, height };
      }, ctx.signal));
  });
}

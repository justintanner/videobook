import type { Engine } from "videobook-engine";
import { queue, registerJobHandler } from "../queue.js";
import { withLocalLease } from "./_lease.js";
import { probeImage, cropToFill } from "../image.js";

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

    return withLocalLease(fs, bookId, assetId, ctx, "process", async () => {
      const readResult = await fs.files.read(assetId, `original${extension}`);
      if (!readResult.ok) throw new Error(`Failed to read original: ${readResult.error.message}`);

      const buffer = Buffer.isBuffer(readResult.value) ? readResult.value : Buffer.from(readResult.value);
      const { width, height } = await probeImage(buffer);

      await fs.metadata.artifacts.write(assetId, "original", { ...provenance, width, height });

      if (!SKIP_CROP_EXTENSIONS.has(extension)) {
        const [landscape, portrait, square] = await Promise.all([
          cropToFill(buffer, 1920, 1080),
          cropToFill(buffer, 1080, 1920),
          cropToFill(buffer, 1080, 1080),
        ]);

        await Promise.all([
          fs.files.write(assetId, "landscape.jpg", landscape),
          fs.files.write(assetId, "portrait.jpg", portrait),
          fs.files.write(assetId, "square.jpg", square),
        ]);
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
    });
  });
}

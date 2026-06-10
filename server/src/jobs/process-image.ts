import type { VideocityFs } from "videocity-engine";
import { registerJobHandler } from "../queue.js";
import { withLocalLease } from "./_lease.js";
import { probeImage, cropToFill } from "../image.js";

export const SKIP_CROP_EXTENSIONS = new Set([".svg", ".gif"]);

type ProcessImagePayload = {
  type: "process_image";
  assetId: string;
  projectSlug: string;
  extension: string;
  provenance: Record<string, unknown>;
};

export function registerProcessImageJob(fs: VideocityFs): void {
  registerJobHandler("process_image", async (payload, ctx) => {
    const {
      assetId, projectSlug, extension, provenance,
    } = payload as ProcessImagePayload;

    return withLocalLease(fs, projectSlug, assetId, ctx, "process", async () => {
      const readResult = await fs.readFile(assetId, `original${extension}`, projectSlug);
      if (!readResult.ok) throw new Error(`Failed to read original: ${readResult.error.message}`);

      const buffer = Buffer.isBuffer(readResult.value) ? readResult.value : Buffer.from(readResult.value);
      const { width, height } = await probeImage(buffer);

      await fs.writeMetadata(assetId, "original", { ...provenance, width, height }, projectSlug);

      if (!SKIP_CROP_EXTENSIONS.has(extension)) {
        const [landscape, portrait, square] = await Promise.all([
          cropToFill(buffer, 1920, 1080),
          cropToFill(buffer, 1080, 1920),
          cropToFill(buffer, 1080, 1080),
        ]);

        await Promise.all([
          fs.writeFile(assetId, "landscape.jpg", landscape, projectSlug),
          fs.writeFile(assetId, "portrait.jpg", portrait, projectSlug),
          fs.writeFile(assetId, "square.jpg", square, projectSlug),
        ]);
      }

      // Vision analysis (describe_image) is gated to slot drop in
      // tools/assign-slot.ts so we don't burn gpt-5.4 on uploads that never
      // land in the timeline.
      return { success: true, width, height };
    });
  });
}

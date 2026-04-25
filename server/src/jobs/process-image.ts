import type { ClipfirstFs } from "clipfirst-fs";
import { queue, registerJobHandler } from "../queue.js";
import { probeImage, cropToFill } from "../image.js";

const SKIP_CROP_EXTENSIONS = new Set([".svg", ".gif"]);

type ProcessImagePayload = {
  type: "process_image";
  assetId: string;
  projectSlug: string;
  extension: string;
  provenance: Record<string, unknown>;
};

export function registerProcessImageJob(fs: ClipfirstFs): void {
  registerJobHandler("process_image", async (payload) => {
    const {
      assetId, projectSlug, extension, provenance,
    } = payload as ProcessImagePayload;

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

    // Auto-enqueue analysis-only describe_image so the asset has
    // `.original.analysis.json` cached for downstream pose/backdrop reads.
    // The compose rail's `usePoseDescription` reads this file directly, and
    // missing it forces the outfit prompt to fall back to skeleton-only.
    // Skipped for SVG/GIF — vision is unreliable on vector/animated formats.
    if (process.env.XAI_API_KEY && !SKIP_CROP_EXTENSIONS.has(extension)) {
      const jobId = `describe-image-auto-${assetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "describe_image",
        sourceAssetId: assetId,
        sourceImageFilename: `original${extension}`,
        projectSlug,
      } as unknown as Record<string, unknown>);
    }

    return { success: true, width, height };
  });
}

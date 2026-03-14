import type { ClipfirstFs } from "clipfirst-fs";
import { registerJobHandler } from "../queue.js";
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
      const [landscape, portrait] = await Promise.all([
        cropToFill(buffer, 1920, 1080),
        cropToFill(buffer, 1080, 1920),
      ]);

      await Promise.all([
        fs.writeFile(assetId, "image_1920x1080.jpg", landscape, projectSlug),
        fs.writeFile(assetId, "image_1080x1920.jpg", portrait, projectSlug),
      ]);
    }

    return { success: true, width, height };
  });
}

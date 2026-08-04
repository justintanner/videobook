import type { Engine, ArtifactManifestFile } from "videobook-engine";
import { z } from "zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import { SKIP_CROP_EXTENSIONS } from "../jobs/process-image.js";
import type { ToolDef } from "./tool-def.js";

const RECT_EPSILON = 0.001;

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);

type ValidationError = { error: string };

function validateRect(
  x: number,
  y: number,
  w: number,
  h: number,
): ValidationError | null {
  if (w <= 0 || h <= 0) return { error: "Crop width and height must be > 0." };
  if (x < 0 || y < 0) return { error: "Crop x and y must be >= 0." };
  if (x + w > 1 + RECT_EPSILON) return { error: `Crop x + w must be <= 1 (got ${x + w}).` };
  if (y + h > 1 + RECT_EPSILON) return { error: `Crop y + h must be <= 1 (got ${y + h}).` };
  return null;
}

function findOriginalImage(files: ArtifactManifestFile[]): ArtifactManifestFile | null {
  const images = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
  // Prefer lossless/true originals when both png and jpg exist (repair cases).
  const byName = (name: string) => images.find((f) => f.name === name);
  return (
    byName("original.png")
    ?? byName("original.webp")
    ?? byName("original.jpg")
    ?? byName("original.jpeg")
    ?? images.find((f) => f.name.startsWith("original"))
    ?? null
  );
}

export function cropImageDef(fs: Engine): ToolDef {
  return {
    name: "crop_image",
    description:
      "Crop an image asset to a 16:9, 9:16, or 1:1 region. Coordinates are normalized fractions of the source image (0..1). Replaces original in place with canonical dims (1920x1080 / 1080x1920 / 1080x1080) and regenerates derived crops with git versioning.",
    schema: {
      asset_id: z.string().describe("Asset ID (e.g. img-my-photo)"),
      book_id: z.string().describe("Book id"),
      ratio: z.enum(["16:9", "9:16", "1:1"]).describe("Target aspect ratio"),
      x: z.number().min(0).max(1).describe("Crop origin X as fraction of source width (0..1)"),
      y: z.number().min(0).max(1).describe("Crop origin Y as fraction of source height (0..1)"),
      w: z.number().min(0).max(1).describe("Crop width as fraction of source width (0..1)"),
      h: z.number().min(0).max(1).describe("Crop height as fraction of source height (0..1)"),
    },
    handler: async (args) => {
      const { asset_id, book_id, ratio, x, y, w, h } = args as {
        asset_id: string; book_id: string;
        ratio: "16:9" | "9:16" | "1:1";
        x: number; y: number; w: number; h: number;
      };

      const rectErr = validateRect(x, y, w, h);
      if (rectErr) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: rectErr.error }],
        };
      }

      const manifestResult = await fs.files.manifest(asset_id);
      if (!manifestResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }

      const manifest = manifestResult.value;
      const imageFile = findOriginalImage(manifest.files);
      if (!imageFile) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `No original image file found in asset ${asset_id}` }],
        };
      }

      const ext = (imageFile.extension ?? extname(imageFile.name)).toLowerCase();
      const extWithDot = ext.startsWith(".") ? ext : `.${ext}`;
      if (SKIP_CROP_EXTENSIONS.has(extWithDot)) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Cannot crop images with extension ${extWithDot}` }],
        };
      }

      const assetDir = manifest.path;
      const jobId = `crop-${asset_id}-${Date.now()}`;

      const jobPayload: Record<string, unknown> = {
        type: "crop_image",
        inputFilename: imageFile.name,
        ratio,
        rect: { x, y, w, h },
        assetId: asset_id,
        assetDir,
        bookId: book_id,
      };

      try {
        await queue.enqueueAndWait(jobId, jobPayload);
      } catch (err) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `Crop failed: ${err instanceof Error ? err.message : String(err)}`,
          }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ asset_id, job_id: jobId, ratio, status: "completed" }),
        }],
      };
    },
  };
}

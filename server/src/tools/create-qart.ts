import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import QRCode from "qrcode";
import sharp from "sharp";
import type { ToolDef, ToolResult } from "./tool-def.js";
import { findImageFile } from "./_image-inputs.js";
import { writeImageVariants } from "./concat-images.js";
import { slugify } from "./_fal-shared.js";

const DEFAULT_SIZE = 512;
const QUIET_MODULES = 4;
const MIN_MODULE_PX = 3;

type QartFilter = "threshold" | "color";
type Rgb = { r: number; g: number; b: number };

function error(text: string): ToolResult {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

function parseHexColor(input: string): Rgb {
  const hex = input.trim().replace(/^#/, "");
  if (hex.length === 3) {
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
    };
  }
  if (hex.length === 6) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }
  return { r: 255, g: 255, b: 255 };
}

function isProtectedModule(row: number, col: number, size: number): boolean {
  if (row < 9 && col < 9) return true;
  if (row < 9 && col >= size - 8) return true;
  if (row >= size - 8 && col < 9) return true;
  if (row === 6 || col === 6) return true;
  return false;
}

function thresholdLuma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b >= 127 ? 255 : 0;
}

export async function buildQartPng(
  value: string,
  coverBuffer: Buffer,
  options: {
    size: number;
    filter: QartFilter;
    background: string;
  },
): Promise<Buffer> {
  const qr = QRCode.create(value, { errorCorrectionLevel: "H" });
  const n = qr.modules.size;
  const totalModules = n + QUIET_MODULES * 2;
  const modulePx = Math.max(MIN_MODULE_PX, Math.floor(options.size / totalModules));
  const working = totalModules * modulePx;
  const dataPx = n * modulePx;

  const cover = await sharp(coverBuffer)
    .resize(dataPx, dataPx, { fit: "cover", position: "centre" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const bg = parseHexColor(options.background);
  const out = Buffer.alloc(working * working * 4);
  for (let i = 0; i < working * working; i++) {
    const o = i * 4;
    out[o] = bg.r;
    out[o + 1] = bg.g;
    out[o + 2] = bg.b;
    out[o + 3] = 255;
  }

  const centerStart = Math.floor(modulePx / 3);
  const centerEnd = Math.ceil((modulePx * 2) / 3);
  const coverData = cover.data;

  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const dark = qr.modules.get(row, col) === 1;
      const qrChannel = dark ? 0 : 255;
      const keepSolid = isProtectedModule(row, col, n);
      const ox = (col + QUIET_MODULES) * modulePx;
      const oy = (row + QUIET_MODULES) * modulePx;

      for (let dy = 0; dy < modulePx; dy++) {
        for (let dx = 0; dx < modulePx; dx++) {
          const x = ox + dx;
          const y = oy + dy;
          const idx = (y * working + x) * 4;
          const isCenter =
            dx >= centerStart && dx < centerEnd && dy >= centerStart && dy < centerEnd;

          if (keepSolid || isCenter) {
            out[idx] = qrChannel;
            out[idx + 1] = qrChannel;
            out[idx + 2] = qrChannel;
            out[idx + 3] = 255;
            continue;
          }

          const cx = col * modulePx + dx;
          const cy = row * modulePx + dy;
          const cidx = (cy * dataPx + cx) * cover.info.channels;
          let r = coverData[cidx] ?? 0;
          let g = coverData[cidx + 1] ?? 0;
          let b = coverData[cidx + 2] ?? 0;
          if (options.filter === "threshold") {
            const t = thresholdLuma(r, g, b);
            r = t;
            g = t;
            b = t;
          }
          out[idx] = r;
          out[idx + 1] = g;
          out[idx + 2] = b;
          out[idx + 3] = 255;
        }
      }
    }
  }

  return sharp(out, {
    raw: { width: working, height: working, channels: 4 },
  })
    .resize(options.size, options.size, { kernel: "nearest" })
    .png()
    .toBuffer();
}

async function readCoverImage(
  fs: VideocityFs,
  imageSlug: string,
  projectSlug: string,
): Promise<{ ok: true; assetId: string; buffer: Buffer } | { ok: false; error: string }> {
  const assetId = imageSlug.replace(/^@/, "");
  if (!assetId.startsWith("img-")) {
    return { ok: false, error: `image_slug must be an img-* asset, got: ${assetId}` };
  }

  const manifestResult = await fs.getManifest(assetId, projectSlug);
  if (!manifestResult.ok) return { ok: false, error: manifestResult.error.message };

  const imageFile = findImageFile(manifestResult.value.files);
  if (!imageFile) return { ok: false, error: `No image file found in asset ${assetId}` };

  const readResult = await fs.readFile(assetId, imageFile.name, projectSlug);
  if (!readResult.ok) return { ok: false, error: readResult.error.message };

  const buffer = Buffer.isBuffer(readResult.value)
    ? readResult.value
    : Buffer.from(readResult.value);
  return { ok: true, assetId, buffer };
}

async function persistQartAsset(
  fs: VideocityFs,
  projectSlug: string,
  assetName: string,
  buffer: Buffer,
  metadata: Record<string, unknown>,
): Promise<{ ok: true; assetId: string } | { ok: false; error: string }> {
  const created = await fs.createAsset("img", assetName, projectSlug);
  if (!created.ok) return { ok: false, error: `Failed to create image asset: ${created.error.message}` };
  const assetId = created.value.assetId;

  const writeResult = await fs.writeFile(assetId, "original.png", buffer, projectSlug);
  if (!writeResult.ok) {
    await fs.deleteAsset(assetId, projectSlug).catch(() => undefined);
    return { ok: false, error: writeResult.error.message };
  }

  const metadataResult = await fs.writeMetadata(assetId, "original", metadata, projectSlug);
  if (!metadataResult.ok) {
    await fs.deleteAsset(assetId, projectSlug).catch(() => undefined);
    return { ok: false, error: metadataResult.error.message };
  }

  let variantsResult: Awaited<ReturnType<typeof writeImageVariants>>;
  try {
    variantsResult = await writeImageVariants(fs, assetId, buffer, projectSlug);
  } catch (err) {
    await fs.deleteAsset(assetId, projectSlug).catch(() => undefined);
    return {
      ok: false,
      error: `Failed to write image variants: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!variantsResult.ok) {
    await fs.deleteAsset(assetId, projectSlug).catch(() => undefined);
    return { ok: false, error: variantsResult.error };
  }

  return { ok: true, assetId };
}

export function createQartDef(fs: VideocityFs): ToolDef {
  return {
    name: "create_qart",
    description:
      "Blend an img-* cover image into a scannable artistic QR code (qart.js-style). Creates two new img-* assets: one on white and one on black.",
    schema: {
      project_slug: z.string().describe("Project slug"),
      image_slug: z.string().describe("Cover image asset (e.g. @img-photo or img-photo)"),
      value: z.string().min(1).describe("Text or URL encoded in the QR code"),
      size: z
        .number()
        .int()
        .min(64)
        .max(2048)
        .optional()
        .describe(`Output edge length in pixels (default ${DEFAULT_SIZE})`),
      filter: z
        .enum(["threshold", "color"])
        .optional()
        .describe("Image filter for non-critical modules: color (default) or threshold"),
      name: z.string().optional().describe("Optional base name for the generated assets"),
    },
    handler: async (args) => {
      const {
        project_slug,
        image_slug,
        value,
        size,
        filter,
        name,
      } = args as {
        project_slug: string;
        image_slug: string;
        value: string;
        size?: number;
        filter?: QartFilter;
        name?: string;
      };

      const resolvedValue = value.trim();
      if (!resolvedValue) return error("value must be a non-empty string");

      const resolvedSize = size ?? DEFAULT_SIZE;
      const resolvedFilter: QartFilter = filter ?? "color";

      const cover = await readCoverImage(fs, image_slug, project_slug);
      if (!cover.ok) return error(cover.error);

      let whiteBuffer: Buffer;
      let blackBuffer: Buffer;
      try {
        [whiteBuffer, blackBuffer] = await Promise.all([
          buildQartPng(resolvedValue, cover.buffer, {
            size: resolvedSize,
            filter: resolvedFilter,
            background: "#FFFFFF",
          }),
          buildQartPng(resolvedValue, cover.buffer, {
            size: resolvedSize,
            filter: resolvedFilter,
            background: "#000000",
          }),
        ]);
      } catch (err) {
        return error(
          `Failed to build qart images: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const stem =
        slugify(name ?? cover.assetId.replace(/^img-/, "")) || String(Date.now());
      const stamp = Date.now().toString(36);
      const baseMeta = {
        origin: "create_qart",
        created_at: new Date().toISOString(),
        value: resolvedValue,
        size: resolvedSize,
        filter: resolvedFilter,
        source_image: cover.assetId,
        width: resolvedSize,
        height: resolvedSize,
      };

      const whiteResult = await persistQartAsset(
        fs,
        project_slug,
        `qart-white-${stem}-${stamp}`,
        whiteBuffer,
        { ...baseMeta, background: "#FFFFFF" },
      );
      if (!whiteResult.ok) return error(whiteResult.error);

      const blackResult = await persistQartAsset(
        fs,
        project_slug,
        `qart-black-${stem}-${stamp}`,
        blackBuffer,
        { ...baseMeta, background: "#000000" },
      );
      if (!blackResult.ok) {
        await fs.deleteAsset(whiteResult.assetId, project_slug).catch(() => undefined);
        return error(blackResult.error);
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            white_asset_id: whiteResult.assetId,
            black_asset_id: blackResult.assetId,
            value: resolvedValue,
            size: resolvedSize,
            filter: resolvedFilter,
            source_image: cover.assetId,
          }),
        }],
      };
    },
  };
}

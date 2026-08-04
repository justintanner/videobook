import type { Engine } from "videobook-engine";
import { z } from "zod";
import QRCode, { type QRCode as QrCode } from "qrcode";
import sharp from "sharp";
import type { ToolDef, ToolResult } from "./tool-def.js";
import { findImageFile } from "./_image-inputs.js";
import { derivedLabel } from "../artifact-label.js";

export const DEFAULT_QART_SIZE = 2520;
export const QART_QUIET_MODULES = 4;
export const QART_MIN_MODULE_PX = 3;
export const QART_MIN_VERSION = 20;
export const QART_IMAGE_STRENGTH = 0.46;
export const QART_DARK_MAX = Math.round(255 * QART_IMAGE_STRENGTH);
export const QART_LIGHT_MIN = Math.round(255 * (1 - QART_IMAGE_STRENGTH));

const LANDSCAPE_WIDTH = 1920;
const LANDSCAPE_HEIGHT = 1080;
const PORTRAIT_WIDTH = 1080;
const PORTRAIT_HEIGHT = 1920;
const SQUARE_SIZE = 1080;

type QartStyle = "color" | "monochrome" | "inverted";

type SampledCover = {
  data: Buffer;
  channels: number;
};

type RenderedQart = {
  buffer: Buffer;
  width: number;
  height: number;
  modulePx: number;
  moduleCount: number;
  qrVersion: number;
};

type QartFiles = {
  original: Buffer;
  landscape: Buffer;
  portrait: Buffer;
  square: Buffer;
  modulePx: number;
};



function error(text: string): ToolResult {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

function createQr(value: string): QrCode {
  const automatic = QRCode.create(value, { errorCorrectionLevel: "H" });
  const version = Math.max(QART_MIN_VERSION, automatic.version);
  if (version === automatic.version) return automatic;
  return QRCode.create(value, { errorCorrectionLevel: "H", version });
}

async function sampleCover(coverBuffer: Buffer, moduleCount: number): Promise<SampledCover> {
  const sampled = await sharp(coverBuffer)
    .rotate()
    .sharpen({ sigma: 1.2 })
    .modulate({ saturation: 1.25 })
    .resize(moduleCount, moduleCount, { fit: "cover", position: "centre" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: sampled.data, channels: sampled.info.channels };
}

function luma(r: number, g: number, b: number): number {
  return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
}

function moduleColor(
  qr: QrCode,
  sampled: SampledCover,
  row: number,
  col: number,
  style: QartStyle,
): readonly [number, number, number] {
  const dark = qr.modules.get(row, col) === 1;
  if (qr.modules.isReserved(row, col)) {
    const channel = dark ? 0 : 255;
    return [channel, channel, channel];
  }

  const sampleIndex = (row * qr.modules.size + col) * sampled.channels;
  const r = sampled.data[sampleIndex] ?? 255;
  const g = sampled.data[sampleIndex + 1] ?? 255;
  const b = sampled.data[sampleIndex + 2] ?? 255;
  
  let source: number[];
  if (style === "monochrome" || style === "inverted") {
    const l = luma(r, g, b);
    source = style === "inverted" ? [255 - l, 255 - l, 255 - l] : [l, l, l];
  } else {
    source = [r, g, b];
  }

  const channels = source.map((channel) => dark
    ? Math.round(channel * QART_IMAGE_STRENGTH)
    : Math.round(255 - (255 - channel) * QART_IMAGE_STRENGTH));
  return [channels[0], channels[1], channels[2]];
}

async function renderQart(
  qr: QrCode,
  sampled: SampledCover,
  style: QartStyle,
  width: number,
  height: number,
): Promise<RenderedQart> {
  const moduleCount = qr.modules.size;
  const totalModules = moduleCount + QART_QUIET_MODULES * 2;
  const modulePx = Math.floor(Math.min(width, height) / totalModules);
  if (modulePx < QART_MIN_MODULE_PX) {
    const minimum = totalModules * QART_MIN_MODULE_PX;
    throw new Error(`size is too small for QR version ${qr.version}; minimum is ${minimum}px`);
  }

  const gridSize = totalModules * modulePx;
  const offsetX = Math.floor((width - gridSize) / 2);
  const offsetY = Math.floor((height - gridSize) / 2);
  const output = Buffer.alloc(width * height * 3, 255);

  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      const color = moduleColor(qr, sampled, row, col, style);
      const originX = offsetX + (col + QART_QUIET_MODULES) * modulePx;
      const originY = offsetY + (row + QART_QUIET_MODULES) * modulePx;
      for (let dy = 0; dy < modulePx; dy++) {
        for (let dx = 0; dx < modulePx; dx++) {
          const outputIndex = ((originY + dy) * width + originX + dx) * 3;
          output[outputIndex] = color[0];
          output[outputIndex + 1] = color[1];
          output[outputIndex + 2] = color[2];
        }
      }
    }
  }

  const buffer = await sharp(output, { raw: { width, height, channels: 3 } }).png().toBuffer();
  return { buffer, width, height, modulePx, moduleCount, qrVersion: qr.version };
}

async function toJpeg(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .jpeg({ quality: 98, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

async function buildStyleFiles(
  qr: QrCode,
  sampled: SampledCover,
  style: QartStyle,
  size: number,
): Promise<QartFiles> {
  const [original, landscapePng, portraitPng, squarePng] = await Promise.all([
    renderQart(qr, sampled, style, size, size),
    renderQart(qr, sampled, style, LANDSCAPE_WIDTH, LANDSCAPE_HEIGHT),
    renderQart(qr, sampled, style, PORTRAIT_WIDTH, PORTRAIT_HEIGHT),
    renderQart(qr, sampled, style, SQUARE_SIZE, SQUARE_SIZE),
  ]);
  const [landscape, portrait, square] = await Promise.all([
    toJpeg(landscapePng.buffer),
    toJpeg(portraitPng.buffer),
    toJpeg(squarePng.buffer),
  ]);
  return {
    original: original.buffer,
    landscape,
    portrait,
    square,
    modulePx: original.modulePx,
  };
}



export async function buildQartPng(
  value: string,
  coverBuffer: Buffer,
  options: { size: number; style: QartStyle },
): Promise<RenderedQart> {
  const qr = createQr(value);
  const sampled = await sampleCover(coverBuffer, qr.modules.size);
  return renderQart(qr, sampled, options.style, options.size, options.size);
}

async function readCoverImage(
  fs: Engine,
  imageRef: string,
  _bookId: string,
): Promise<{ ok: true; assetId: string; buffer: Buffer } | { ok: false; error: string }> {
  const assetId = imageRef.replace(/^@/, "");
  const artifact = fs.artifacts.get(assetId);
  if (!artifact.ok) return { ok: false, error: artifact.error.message };
  if (artifact.value.kind !== "image") {
    return { ok: false, error: `image_ref must be an image artifact, got ${artifact.value.kind}: ${assetId}` };
  }

  const manifestResult = await fs.files.manifest(assetId);
  if (!manifestResult.ok) return { ok: false, error: manifestResult.error.message };

  const imageFile = findImageFile(manifestResult.value.files);
  if (!imageFile) return { ok: false, error: `No image file found in asset ${assetId}` };

  const readResult = await fs.files.read(assetId, imageFile.name);
  if (!readResult.ok) return { ok: false, error: readResult.error.message };

  const buffer = Buffer.isBuffer(readResult.value)
    ? readResult.value
    : Buffer.from(readResult.value);
  return { ok: true, assetId, buffer };
}

async function persistQartAsset(
  fs: Engine,
  bookId: string,
  assetName: string,
  files: QartFiles,
  metadata: Record<string, unknown>,
): Promise<{ ok: true; assetId: string } | { ok: false; error: string }> {
  const created = await fs.artifacts.create("img", assetName);
  if (!created.ok) return { ok: false, error: `Failed to create image asset: ${created.error.message}` };
  const assetId = created.value.artifactId;
  const writes = await Promise.all([
    fs.files.write(assetId, "original.png", files.original),
    fs.files.write(assetId, "landscape.jpg", files.landscape),
    fs.files.write(assetId, "portrait.jpg", files.portrait),
    fs.files.write(assetId, "square.jpg", files.square),
  ]);
  const writeFailure = writes.find((result) => !result.ok);
  if (writeFailure && !writeFailure.ok) {
    await fs.artifacts.delete(assetId).catch(() => undefined);
    return { ok: false, error: writeFailure.error.message };
  }

  const metadataResult = await fs.metadata.artifacts.write(assetId, "original", metadata);
  if (!metadataResult.ok) {
    await fs.artifacts.delete(assetId).catch(() => undefined);
    return { ok: false, error: metadataResult.error.message };
  }
  return { ok: true, assetId };
}

export function createQartDef(fs: Engine): ToolDef {
  return {
    name: "create_qart",
    description:
      "Create scan-safe color and monochrome QR mosaics from a source image artifact. The image is sampled per QR module with protected QR structures and white quiet zones.",
    schema: {
      book_id: z.string().describe("Book id"),
      image_ref: z.string().describe("Source image artifact id"),
      value: z.string().min(1).describe("Text or URL encoded in the QR code"),
      size: z
        .number()
        .int()
        .min(256)
        .max(4096)
        .optional()
        .describe(`Output edge length in pixels (default ${DEFAULT_QART_SIZE})`),
      style: z
        .enum(["color", "monochrome", "inverted"])
        .optional()
        .describe("Style of the QArt output. 'color', 'monochrome', or 'inverted' (default)"),
      name: z.string().optional().describe("Optional base name for the generated assets"),
    },
    handler: async (args) => {
      const {
        book_id,
        image_ref,
        value,
        size,
        style,
        name,
      } = args as {
        book_id: string;
        image_ref: string;
        value: string;
        size?: number;
        style?: QartStyle;
        name?: string;
      };

      const resolvedValue = value.trim();
      if (!resolvedValue) return error("value must be a non-empty string");
      const resolvedSize = size ?? DEFAULT_QART_SIZE;
      const stylesToBuild = style ? [style] : (["inverted", "monochrome"] as QartStyle[]);
      const cover = await readCoverImage(fs, image_ref, book_id);
      if (!cover.ok) return error(cover.error);

      const qr = createQr(resolvedValue);
      const sampled = await sampleCover(cover.buffer, qr.modules.size);

      const stem = name ?? cover.assetId;
      const createdAt = new Date().toISOString();
      const baseMeta = {
        origin: "create_qart",
        qart_style: "module_mosaic",
        created_at: createdAt,
        value: resolvedValue,
        source_image: cover.assetId,
        width: resolvedSize,
        height: resolvedSize,
        qr_version: qr.version,
        error_correction: "H",
        quiet_zone_modules: QART_QUIET_MODULES,
        image_strength: QART_IMAGE_STRENGTH,
        sample_grid: `${qr.modules.size}x${qr.modules.size}`,
      };

      const resultIds: Record<string, string> = {};

      for (const s of stylesToBuild) {
        let buildFiles: QartFiles;
        try {
          buildFiles = await buildStyleFiles(qr, sampled, s, resolvedSize);
        } catch (err) {
          return error(
            `Failed to build QR mosaic: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        const resultAsset = await persistQartAsset(
          fs,
          book_id,
          derivedLabel(`qart ${s}`, stem),
          buildFiles,
          { ...baseMeta, color_mode: s, module_pixels: buildFiles.modulePx },
        );
        if (!resultAsset.ok) return error(resultAsset.error);

        if (style) {
          resultIds.asset_id = resultAsset.assetId;
          resultIds.style = s;
        } else {
          resultIds[`${s}_asset_id`] = resultAsset.assetId;
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ...resultIds,
            value: resolvedValue,
            size: resolvedSize,
            source_image: cover.assetId,
            qr_version: qr.version,
          }),
        }],
      };
    },
  };
}

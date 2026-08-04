import type { Engine } from "videobook-engine";
import { z } from "zod";
import sharp from "sharp";
import type { ToolDef, ToolResult } from "./tool-def.js";
import { derivedLabel } from "../artifact-label.js";
import {
  buildQrbtfSvg,
  wrapQrbtfSvg,
  type QrbtfStyle,
  type QrbtfParams,
} from "./qrbtf-render.js";

export const DEFAULT_QRBTF_SIZE = 1024;

const LANDSCAPE_WIDTH = 1920;
const LANDSCAPE_HEIGHT = 1080;
const PORTRAIT_WIDTH = 1080;
const PORTRAIT_HEIGHT = 1920;
const SQUARE_SIZE = 1080;

type QrbtfFiles = {
  original: Buffer;
  landscape: Buffer;
  portrait: Buffer;
  square: Buffer;
};

type RenderedQrbtf = {
  buffer: Buffer;
  width: number;
  height: number;
  qrVersion: number;
  moduleCount: number;
};

function error(text: string): ToolResult {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

async function toJpeg(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer).jpeg({ quality: 98, chromaSubsampling: "4:4:4" }).toBuffer();
}

async function renderAtSize(
  content: string,
  viewBox: string,
  bgColor: string,
  width: number,
  height: number,
): Promise<Buffer> {
  const svg = wrapQrbtfSvg({ content, viewBox, bgColor }, width, height);
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function renderVariant(
  content: string,
  viewBox: string,
  bgColor: string,
  width: number,
  height: number,
): Promise<Buffer> {
  const minDim = Math.min(width, height);
  const qrPng = await renderAtSize(content, viewBox, bgColor, minDim, minDim);
  const left = Math.floor((width - minDim) / 2);
  const top = Math.floor((height - minDim) / 2);
  if (left === 0 && top === 0) return toJpeg(qrPng);
  return sharp(qrPng)
    .extend({
      left,
      top,
      right: width - minDim - left,
      bottom: height - minDim - top,
      background: bgColor,
    })
    .jpeg({ quality: 98, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

async function buildQrbtfFiles(
  content: string,
  viewBox: string,
  bgColor: string,
  size: number,
): Promise<QrbtfFiles> {
  const [original, landscape, portrait, square] = await Promise.all([
    renderAtSize(content, viewBox, bgColor, size, size),
    renderVariant(content, viewBox, bgColor, LANDSCAPE_WIDTH, LANDSCAPE_HEIGHT),
    renderVariant(content, viewBox, bgColor, PORTRAIT_WIDTH, PORTRAIT_HEIGHT),
    renderVariant(content, viewBox, bgColor, SQUARE_SIZE, SQUARE_SIZE),
  ]);
  return {
    original,
    landscape,
    portrait,
    square,
  };
}

export async function buildQrbtfPng(
  value: string,
  style: QrbtfStyle,
  params: QrbtfParams,
  size: number,
): Promise<RenderedQrbtf> {
  const r = buildQrbtfSvg(value, style, params);
  const buffer = await renderAtSize(r.content, r.viewBox, r.bgColor, size, size);
  return {
    buffer,
    width: size,
    height: size,
    qrVersion: r.version,
    moduleCount: r.moduleCount,
  };
}

async function persistQrbtfAsset(
  fs: Engine,
  bookId: string,
  assetName: string,
  files: QrbtfFiles,
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

export function createQrbtfDef(fs: Engine): ToolDef {
  return {
    name: "create_qrbtf",
    description:
      "Generate parametric QR codes in artistic styles (normal, line, dsj, bubble, func) from the qrbtf library. Renders SVG and rasterizes to image assets. Black background with bright modules by default.",
    schema: {
      book_id: z.string().describe("Book id"),
      value: z.string().min(1).describe("Text or URL encoded in the QR code"),
      style: z
        .enum(["normal", "line", "dsj", "bubble", "func"])
        .optional()
        .describe("QR style (default: normal)"),
      point_type: z
        .enum(["rect", "round", "rand"])
        .optional()
        .describe("Data point shape for normal/func styles"),
      pos_type: z
        .enum(["rect", "round", "planet", "roundRect"])
        .optional()
        .describe("Position detection pattern shape"),
      direction: z
        .enum(["left-right", "up-down", "h-v", "loop", "topLeft-bottomRight", "topRight-bottomLeft", "cross"])
        .optional()
        .describe("Line direction for line style"),
      func_type: z
        .enum(["A", "B"])
        .optional()
        .describe("Function type for func style"),
      other_color: z
        .string()
        .optional()
        .describe("Data module color (hex, e.g. #FFFFFF)"),
      other_color_2: z
        .string()
        .optional()
        .describe("Secondary color for func style (hex)"),
      pos_color: z
        .string()
        .optional()
        .describe("Position pattern color (hex)"),
      bg_color: z
        .string()
        .optional()
        .describe("Background / quiet-zone color (hex, default #000000)"),
      size: z
        .number()
        .int()
        .min(256)
        .max(4096)
        .optional()
        .describe(`Output edge length in pixels (default ${DEFAULT_QRBTF_SIZE})`),
      name: z.string().optional().describe("Optional base name for the generated asset"),
    },
    handler: async (args) => {
      const {
        book_id,
        value,
        style,
        point_type,
        pos_type,
        direction,
        func_type,
        other_color,
        other_color_2,
        pos_color,
        bg_color,
        size,
        name,
      } = args as {
        book_id: string;
        value: string;
        style?: QrbtfStyle;
        point_type?: "rect" | "round" | "rand";
        pos_type?: "rect" | "round" | "planet" | "roundRect";
        direction?: string;
        func_type?: "A" | "B";
        other_color?: string;
        other_color_2?: string;
        pos_color?: string;
        bg_color?: string;
        size?: number;
        name?: string;
      };

      const resolvedValue = value.trim();
      if (!resolvedValue) return error("value must be a non-empty string");
      const resolvedStyle = style ?? "normal";
      const resolvedSize = size ?? DEFAULT_QRBTF_SIZE;

      const params: QrbtfParams = {};
      if (point_type) params.pointType = point_type;
      if (pos_type) params.posType = pos_type;
      if (direction) params.direction = direction as QrbtfParams["direction"];
      if (func_type) params.funcType = func_type;
      if (other_color) params.otherColor = other_color;
      if (other_color_2) params.otherColor2 = other_color_2;
      if (pos_color) params.posColor = pos_color;
      if (bg_color) params.bgColor = bg_color;

      const r = buildQrbtfSvg(resolvedValue, resolvedStyle, params);

      let files: QrbtfFiles;
      try {
        files = await buildQrbtfFiles(r.content, r.viewBox, r.bgColor, resolvedSize);
      } catch (err) {
        return error(`Failed to render QR: ${err instanceof Error ? err.message : String(err)}`);
      }

      const stem = name ?? resolvedStyle;
      const createdAt = new Date().toISOString();

      const metadata: Record<string, unknown> = {
        origin: "create_qrbtf",
        qrbtf_style: resolvedStyle,
        created_at: createdAt,
        value: resolvedValue,
        width: resolvedSize,
        height: resolvedSize,
        qr_version: r.version,
        error_correction: "H",
        bg_color: r.bgColor,
        module_count: r.moduleCount,
      };
      if (other_color) metadata.other_color = other_color;
      if (pos_color) metadata.pos_color = pos_color;
      if (point_type) metadata.point_type = point_type;
      if (pos_type) metadata.pos_type = pos_type;
      if (direction) metadata.direction = direction;
      if (func_type) metadata.func_type = func_type;

      const resultAsset = await persistQrbtfAsset(
        fs,
        book_id,
        derivedLabel("qrbtf", stem),
        files,
        metadata,
      );
      if (!resultAsset.ok) return error(resultAsset.error);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            asset_id: resultAsset.assetId,
            value: resolvedValue,
            style: resolvedStyle,
            size: resolvedSize,
            qr_version: r.version,
            bg_color: r.bgColor,
          }),
        }],
      };
    },
  };
}

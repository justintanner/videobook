import type { Engine } from "videobook-engine";
import sharp from "sharp";
import QRCode from "qrcode";
import { writeImageVariants } from "./tools/concat-images.js";

export const DEFAULT_HANDLE = "justinwtanner";

// Layout identifier persisted in artifact metadata so apply_watermark can
// reuse an existing badge and skip regenerating an identical one.
export const WATERMARK_BADGE_LAYOUT = "badge-v5";
const WATERMARK_HANDLE_LAYOUT = "handle-v4";
const WATERMARK_QR_LAYOUT = "qr-v1";

export const BADGE_WIDTH = 480;
const QR_SIZE = 384;
const TILE_PAD = 48; // white frame around the QR — ≥4 quiet-zone modules up to QR v5
const TILE_SIZE = QR_SIZE + TILE_PAD * 2; // 480
const PILL_GAP = 12;
const PILL_HEIGHT = 88;
const HANDLE_PILL_CONTENT = 26;
export const BADGE_HEIGHT = TILE_SIZE + PILL_GAP + PILL_HEIGHT; // 580
export const BADGE_ASPECT = BADGE_WIDTH / BADGE_HEIGHT;
export const QR_ONLY_BADGE_HEIGHT = TILE_SIZE;
export const QR_ONLY_BADGE_ASPECT = BADGE_WIDTH / QR_ONLY_BADGE_HEIGHT;
export const HANDLE_ONLY_BADGE_HEIGHT = PILL_HEIGHT;
export const DEFAULT_HANDLE_PADDING = 32;
export const MIN_HANDLE_PADDING = 0;
export const MAX_HANDLE_PADDING = 96;
export const DEFAULT_HANDLE_ROUNDING = 100;
export const MIN_HANDLE_ROUNDING = 0;
export const MAX_HANDLE_ROUNDING = 100;

export type WatermarkBadgeVariant = "combined" | "qr" | "handle";

type WatermarkBadgeOptions = {
  includeQr?: boolean;
  variant?: WatermarkBadgeVariant;
  includeXIcon?: boolean;
  includeHandleBorder?: boolean;
  handlePadding?: number;
  handlePaddingY?: number;
  handleRounding?: number;
};

const X_LOGO_PATH =
  "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z";

export function defaultUrl(handle: string): string {
  return `https://x.com/${handle}`;
}

export function watermarkHandleLabel(handle: string): string {
  return handle.replace(/^@/, "");
}

function clampHandlePadding(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_HANDLE_PADDING;
  return Math.round(Math.min(MAX_HANDLE_PADDING, Math.max(MIN_HANDLE_PADDING, value)));
}

export function handlePillHeight(paddingY: number = DEFAULT_HANDLE_PADDING): number {
  const clamped = clampHandlePadding(paddingY);
  return Math.max(
    HANDLE_PILL_CONTENT + 4,
    PILL_HEIGHT + 2 * (clamped - DEFAULT_HANDLE_PADDING),
  );
}

export function watermarkCombinedBadgeHeight(
  paddingY: number = DEFAULT_HANDLE_PADDING,
): number {
  return TILE_SIZE + PILL_GAP + handlePillHeight(paddingY);
}

function clampHandleRounding(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_HANDLE_ROUNDING;
  return Math.round(Math.min(MAX_HANDLE_ROUNDING, Math.max(MIN_HANDLE_ROUNDING, value)));
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function watermarkBadgeAspect(
  includeQr = true,
  paddingY: number = DEFAULT_HANDLE_PADDING,
): number {
  return BADGE_WIDTH / (
    includeQr ? watermarkCombinedBadgeHeight(paddingY) : handlePillHeight(paddingY)
  );
}

function watermarkBadgeVariant(options: WatermarkBadgeOptions): WatermarkBadgeVariant {
  return options.variant ?? (options.includeQr === false ? "handle" : "combined");
}

function watermarkBadgeLayout(variant: WatermarkBadgeVariant): string {
  if (variant === "qr") return WATERMARK_QR_LAYOUT;
  return variant === "combined" ? WATERMARK_BADGE_LAYOUT : WATERMARK_HANDLE_LAYOUT;
}

function watermarkBadgeHeight(
  variant: WatermarkBadgeVariant,
  paddingY: number,
): number {
  if (variant === "qr") return QR_ONLY_BADGE_HEIGHT;
  return variant === "combined"
    ? watermarkCombinedBadgeHeight(paddingY)
    : handlePillHeight(paddingY);
}

export async function buildWatermarkBadgePng(
  url: string,
  handle: string,
  options: WatermarkBadgeOptions = {},
): Promise<Buffer> {
  const variant = watermarkBadgeVariant(options);
  const includeQr = variant !== "handle";
  const includeHandle = variant !== "qr";
  const includeXIcon = includeHandle && (options.includeXIcon ?? true);
  const includeHandleBorder = includeHandle && (options.includeHandleBorder ?? true);
  const handlePadding = clampHandlePadding(options.handlePadding ?? DEFAULT_HANDLE_PADDING);
  const handlePaddingY = clampHandlePadding(options.handlePaddingY ?? DEFAULT_HANDLE_PADDING);
  const handleRounding = clampHandleRounding(options.handleRounding ?? DEFAULT_HANDLE_ROUNDING);
  const qrBuffer = includeQr
    ? await QRCode.toBuffer(url, {
        type: "png",
        margin: 0,
        color: { dark: "#0B0B0F", light: "#FFFFFF" },
        errorCorrectionLevel: "H",
        width: QR_SIZE,
      })
    : null;

  const pillHeight = handlePillHeight(handlePaddingY);
  const badgeHeight = watermarkBadgeHeight(variant, handlePaddingY);
  const pillY = variant === "combined" ? TILE_SIZE + PILL_GAP : 0;
  const label = watermarkHandleLabel(handle);
  const iconSize = HANDLE_PILL_CONTENT;
  const iconGap = 14;
  const iconSpace = includeXIcon ? iconSize + iconGap : 0;
  const availableWidth = BADGE_WIDTH - 2 - handlePadding * 2 - iconSpace;
  const fontSize = Math.max(
    12,
    Math.min(28, Math.floor(availableWidth / (0.6 * Math.max(1, Array.from(label).length)))),
  );
  const labelWidth = Math.min(availableWidth, fontSize * 0.6 * Array.from(label).length);
  const contentWidth = iconSpace + labelWidth;
  const contentX = (BADGE_WIDTH - contentWidth) / 2;
  const pillWidth = Math.min(BADGE_WIDTH - 2, Math.ceil(contentWidth + handlePadding * 2));
  const pillX = (BADGE_WIDTH - pillWidth) / 2;
  const labelX = includeXIcon ? contentX + iconSpace : BADGE_WIDTH / 2;
  const labelAnchor = includeXIcon ? "start" : "middle";
  const labelY = pillY + pillHeight / 2 + 1;
  const logoY = pillY + (pillHeight - iconSize) / 2;
  const pillRadius = ((pillHeight - 2) / 2) * (handleRounding / 100);
  const border = includeHandleBorder
    ? ` stroke="#FFFFFF" stroke-opacity="0.55" stroke-width="2"`
    : "";

  const tile = includeQr
    ? `<rect x="0" y="0" width="${TILE_SIZE}" height="${TILE_SIZE}" rx="40" fill="#FFFFFF"/>`
    : "";
  const pill = includeHandle
    ? `<rect x="${pillX}" y="${pillY + 1}" width="${pillWidth}" height="${pillHeight - 2}" rx="${pillRadius}" fill="#0B0B0F" fill-opacity="0.92"${border}/>
  ${includeXIcon ? `<svg x="${contentX}" y="${logoY}" width="${iconSize}" height="${iconSize}" viewBox="0 0 24 24"><path d="${X_LOGO_PATH}" fill="#FFFFFF"/></svg>` : ""}
  <text x="${labelX}" y="${labelY}" text-anchor="${labelAnchor}" dominant-baseline="central" font-family="Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="700" letter-spacing="0.1" fill="#FFFFFF">${escapeXml(label)}</text>`
    : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${BADGE_WIDTH}" height="${badgeHeight}" viewBox="0 0 ${BADGE_WIDTH} ${badgeHeight}">
  ${tile}
  ${pill}
</svg>`;

  const background = await sharp(Buffer.from(svg)).png().toBuffer();
  if (!qrBuffer) return background;

  return sharp(background)
    .composite([{ input: qrBuffer, top: TILE_PAD, left: TILE_PAD }])
    .png()
    .toBuffer();
}

type WatermarkAssetResult =
  | { ok: true; assetId: string }
  | { ok: false; error: string };

/** Build the badge and persist it as an image artifact with preview variants. */
export async function createWatermarkAsset(
  engine: Engine,
  handle: string,
  url: string,
  options: WatermarkBadgeOptions = {},
): Promise<WatermarkAssetResult> {
  const variant = watermarkBadgeVariant(options);
  const includeXIcon = options.includeXIcon ?? true;
  const includeHandleBorder = options.includeHandleBorder ?? true;
  const handlePadding = clampHandlePadding(options.handlePadding ?? DEFAULT_HANDLE_PADDING);
  const handlePaddingY = clampHandlePadding(options.handlePaddingY ?? DEFAULT_HANDLE_PADDING);
  const handleRounding = clampHandleRounding(options.handleRounding ?? DEFAULT_HANDLE_ROUNDING);
  let buffer: Buffer;
  try {
    buffer = await buildWatermarkBadgePng(url, handle, {
      variant,
      includeXIcon,
      includeHandleBorder,
      handlePadding,
      handlePaddingY,
      handleRounding,
    });
  } catch (err) {
    return { ok: false, error: `Failed to build watermark card: ${err instanceof Error ? err.message : String(err)}` };
  }

  const assetIdentity = handle.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "link";
  const assetName = `watermark-${variant}-${assetIdentity}-${Date.now().toString(36)}`;
  const created = await engine.artifacts.create("img", assetName);
  if (!created.ok) {
    return { ok: false, error: `Failed to create image asset: ${created.error.message}` };
  }
  const assetId = created.value.artifactId;

  const writeResult = await engine.files.write(assetId, "original.png", buffer);
  if (!writeResult.ok) {
    await engine.artifacts.delete(assetId).catch(() => undefined);
    return { ok: false, error: writeResult.error.message };
  }

  const metadataResult = await engine.metadata.artifacts.write(assetId, "original", {
    origin: "watermark",
    layout: watermarkBadgeLayout(variant),
    created_at: new Date().toISOString(),
    handle,
    url,
    include_qr: variant !== "handle",
    include_handle: variant !== "qr",
    include_x_icon: variant !== "qr" && includeXIcon,
    include_handle_border: variant !== "qr" && includeHandleBorder,
    handle_padding: variant !== "qr" ? handlePadding : null,
    handle_padding_y: variant !== "qr" ? handlePaddingY : null,
    handle_rounding: variant !== "qr" ? handleRounding : null,
    width: BADGE_WIDTH,
    height: watermarkBadgeHeight(variant, handlePaddingY),
  });
  if (!metadataResult.ok) {
    await engine.artifacts.delete(assetId).catch(() => undefined);
    return { ok: false, error: metadataResult.error.message };
  }

  const variantsResult = await writeImageVariants(engine, assetId, buffer);
  if (!variantsResult.ok) {
    await engine.artifacts.delete(assetId).catch(() => undefined);
    return { ok: false, error: variantsResult.error };
  }

  return { ok: true, assetId };
}

/** Find an existing badge artifact for this handle + url (same layout), so
 *  repeated applies share one card instead of minting duplicates. */
export async function findWatermarkAsset(
  engine: Engine,
  handle: string,
  url: string,
  options: WatermarkBadgeOptions = {},
): Promise<string | null> {
  const variant = watermarkBadgeVariant(options);
  const layout = watermarkBadgeLayout(variant);
  const includeXIcon = options.includeXIcon ?? true;
  const includeHandleBorder = options.includeHandleBorder ?? true;
  const handlePadding = clampHandlePadding(options.handlePadding ?? DEFAULT_HANDLE_PADDING);
  const handlePaddingY = clampHandlePadding(options.handlePaddingY ?? DEFAULT_HANDLE_PADDING);
  const handleRounding = clampHandleRounding(options.handleRounding ?? DEFAULT_HANDLE_ROUNDING);
  for (const artifact of engine.artifacts.list()) {
    if (artifact.kind !== "image") continue;
    const meta = await engine.metadata.artifacts.read<Record<string, unknown>>(artifact.artifactId, "original");
    if (!meta.ok) continue;
    const storedPaddingY = typeof meta.value.handle_padding_y === "number"
      ? meta.value.handle_padding_y
      : DEFAULT_HANDLE_PADDING;
    if (
      meta.value.origin === "watermark"
      && meta.value.layout === layout
      && meta.value.handle === handle
      && (variant === "handle" || meta.value.url === url)
      && (variant === "qr" || meta.value.include_x_icon === includeXIcon)
      && (variant === "qr" || meta.value.include_handle_border === includeHandleBorder)
      && (variant === "qr" || meta.value.handle_padding === handlePadding)
      && (variant === "qr" || storedPaddingY === handlePaddingY)
      && (variant === "qr" || meta.value.handle_rounding === handleRounding)
    ) {
      return artifact.artifactId;
    }
  }
  return null;
}

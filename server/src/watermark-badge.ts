import type { Engine } from "videobook-engine";
import sharp from "sharp";
import QRCode from "qrcode";
import { writeImageVariants } from "./tools/concat-images.js";

export const DEFAULT_HANDLE = "justinwtanner";

// Layout identifier persisted in artifact metadata so apply_watermark can
// reuse an existing badge and skip regenerating an identical one.
export const WATERMARK_BADGE_LAYOUT = "badge-v2";

// Compact floating badge on a transparent canvas: a rounded white tile framing
// the QR (the tile doubles as the quiet zone) with a slim dark pill underneath
// carrying the X glyph + @handle. Designed to stay legible composited at ~50%
// opacity over arbitrary video: the white tile keeps the QR contrast, the
// pill's white hairline keeps the handle visible on dark footage.
export const BADGE_WIDTH = 480;
const QR_SIZE = 384;
const TILE_PAD = 48; // white frame around the QR — ≥4 quiet-zone modules up to QR v5
const TILE_SIZE = QR_SIZE + TILE_PAD * 2; // 480
const PILL_GAP = 12;
const PILL_HEIGHT = 88;
export const BADGE_HEIGHT = TILE_SIZE + PILL_GAP + PILL_HEIGHT; // 580
export const BADGE_ASPECT = BADGE_WIDTH / BADGE_HEIGHT;

// The X (formerly Twitter) glyph, viewBox 0 0 24 24.
const X_LOGO_PATH =
  "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z";

export function defaultUrl(handle: string): string {
  return `https://x.com/${handle}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function buildWatermarkBadgePng(url: string, handle: string): Promise<Buffer> {
  const qrBuffer = await QRCode.toBuffer(url, {
    type: "png",
    margin: 0,
    color: { dark: "#0B0B0F", light: "#FFFFFF" },
    errorCorrectionLevel: "H",
    width: QR_SIZE,
  });

  const pillY = TILE_SIZE + PILL_GAP;
  const logoSize = 40;
  const logoX = 30;
  const logoY = pillY + (PILL_HEIGHT - logoSize) / 2;
  const handleX = logoX + logoSize + 16;
  const label = `@${handle}`;
  const availableWidth = BADGE_WIDTH - handleX - 24;
  const fontSize = Math.min(40, Math.floor(availableWidth / (0.6 * Array.from(label).length)));
  const baseline = pillY + PILL_HEIGHT / 2 + Math.round(fontSize * 0.35);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${BADGE_WIDTH}" height="${BADGE_HEIGHT}" viewBox="0 0 ${BADGE_WIDTH} ${BADGE_HEIGHT}">
  <rect x="0" y="0" width="${TILE_SIZE}" height="${TILE_SIZE}" rx="40" fill="#FFFFFF"/>
  <rect x="1" y="${pillY + 1}" width="${BADGE_WIDTH - 2}" height="${PILL_HEIGHT - 2}" rx="44" fill="#0B0B0F" fill-opacity="0.92" stroke="rgba(255,255,255,0.55)" stroke-width="2"/>
  <svg x="${logoX}" y="${logoY}" width="${logoSize}" height="${logoSize}" viewBox="0 0 24 24"><path d="${X_LOGO_PATH}" fill="#FFFFFF"/></svg>
  <text x="${handleX}" y="${baseline}" font-family="Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="700" letter-spacing="0.2" fill="#FFFFFF">${escapeXml(label)}</text>
</svg>`;

  const background = await sharp(Buffer.from(svg)).png().toBuffer();

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
): Promise<WatermarkAssetResult> {
  let buffer: Buffer;
  try {
    buffer = await buildWatermarkBadgePng(url, handle);
  } catch (err) {
    return { ok: false, error: `Failed to build watermark card: ${err instanceof Error ? err.message : String(err)}` };
  }

  const assetName = `watermark-${handle.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now().toString(36)}`;
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
    layout: WATERMARK_BADGE_LAYOUT,
    created_at: new Date().toISOString(),
    handle,
    url,
    width: BADGE_WIDTH,
    height: BADGE_HEIGHT,
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
): Promise<string | null> {
  for (const artifact of engine.artifacts.list()) {
    if (artifact.kind !== "image") continue;
    const meta = await engine.metadata.artifacts.read<Record<string, unknown>>(artifact.artifactId, "original");
    if (!meta.ok) continue;
    if (
      meta.value.origin === "watermark"
      && meta.value.layout === WATERMARK_BADGE_LAYOUT
      && meta.value.handle === handle
      && meta.value.url === url
    ) {
      return artifact.artifactId;
    }
  }
  return null;
}

import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import sharp from "sharp";
import QRCode from "qrcode";
import type { ToolDef } from "./tool-def.js";
import { writeImageVariants } from "./concat-images.js";
import { recordHandle } from "../watermark-config.js";

const DEFAULT_HANDLE = "justinwtanner";

// Stylish dark card: an X logo + "@handle" header above a rounded white tile
// that frames the QR. The white tile doubles as the QR quiet zone.
const QR_SIZE = 240;
const TILE_PAD = 16; // white frame around the QR (quiet zone)
const TILE_SIZE = QR_SIZE + TILE_PAD * 2; // 272
const OUTER_PAD = 24; // dark card padding around its contents
const HEADER_HEIGHT = 40;
const HEADER_GAP = 18; // header → tile spacing
const CARD_WIDTH = TILE_SIZE + OUTER_PAD * 2; // 320
const CARD_HEIGHT = OUTER_PAD + HEADER_HEIGHT + HEADER_GAP + TILE_SIZE + OUTER_PAD; // 378

// The X (formerly Twitter) glyph, viewBox 0 0 24 24.
const X_LOGO_PATH =
  "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z";

function defaultUrl(handle: string): string {
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

// Render the QR watermark card as a PNG buffer: a rounded near-black card with
// an X logo + "@handle" header and the QR set on a rounded white tile. Persisted
// as an img-* asset and composited via OSG.
async function buildCardPng(url: string, handle: string): Promise<Buffer> {
  const qrBuffer = await QRCode.toBuffer(url, {
    type: "png",
    margin: 1,
    color: { dark: "#0B0B0F", light: "#FFFFFF" },
    errorCorrectionLevel: "M",
    width: QR_SIZE,
  });

  const tileX = OUTER_PAD;
  const tileY = OUTER_PAD + HEADER_HEIGHT + HEADER_GAP;
  const logoSize = 26;
  const logoX = OUTER_PAD;
  const logoY = OUTER_PAD + (HEADER_HEIGHT - logoSize) / 2;
  const handleX = logoX + logoSize + 12;
  const handleBaseline = OUTER_PAD + HEADER_HEIGHT / 2 + 8;
  const label = `@${handle}`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">
  <defs>
    <linearGradient id="card" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#16161D"/>
      <stop offset="1" stop-color="#0A0A0F"/>
    </linearGradient>
  </defs>
  <rect x="1" y="1" width="${CARD_WIDTH - 2}" height="${CARD_HEIGHT - 2}" rx="28" fill="url(#card)" stroke="#26262F" stroke-width="1.5"/>
  <svg x="${logoX}" y="${logoY}" width="${logoSize}" height="${logoSize}" viewBox="0 0 24 24"><path d="${X_LOGO_PATH}" fill="#FFFFFF"/></svg>
  <text x="${handleX}" y="${handleBaseline}" font-family="Helvetica, Arial, sans-serif" font-size="22" font-weight="700" letter-spacing="0.2" fill="#FFFFFF">${escapeXml(label)}</text>
  <rect x="${tileX}" y="${tileY}" width="${TILE_SIZE}" height="${TILE_SIZE}" rx="20" fill="#FFFFFF"/>
</svg>`;

  const background = await sharp(Buffer.from(svg)).png().toBuffer();

  return sharp(background)
    .composite([{ input: qrBuffer, top: tileY + TILE_PAD, left: tileX + TILE_PAD }])
    .png()
    .toBuffer();
}

export function createWatermarkDef(fs: VideocityFs): ToolDef {
  return {
    name: "create_watermark",
    description:
      "Generate a black-and-white QR + 'X: <handle>' watermark card and store it as an img- asset. Apply it via the on-screen graphic (OSG) settings during render.",
    schema: {
      project_slug: z.string().describe("Project slug"),
      handle: z.string().optional().describe(`X handle without @ (default: ${DEFAULT_HANDLE})`),
      url: z.string().optional().describe("URL the QR code resolves to (default: https://x.com/<handle>)"),
      save_default: z
        .boolean()
        .optional()
        .describe("Remember this handle as the default for future watermarks"),
    },
    handler: async (args) => {
      const { project_slug, handle, url, save_default } = args as {
        project_slug: string; handle?: string; url?: string; save_default?: boolean;
      };

      const resolvedHandle = (handle ?? DEFAULT_HANDLE).replace(/^@/, "").trim();
      if (!resolvedHandle) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "handle must be a non-empty string" }],
        };
      }
      const resolvedUrl = url ?? defaultUrl(resolvedHandle);

      let buffer: Buffer;
      try {
        buffer = await buildCardPng(resolvedUrl, resolvedHandle);
      } catch (err) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to build watermark card: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }

      const assetName = `watermark-${resolvedHandle.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now().toString(36)}`;
      const created = await fs.createAsset("img", assetName, project_slug);
      if (!created.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create image asset: ${created.error.message}` }],
        };
      }
      const assetId = created.value.assetId;

      const writeResult = await fs.writeFile(assetId, "original.png", buffer, project_slug);
      if (!writeResult.ok) {
        await fs.deleteAsset(assetId, project_slug).catch(() => undefined);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: writeResult.error.message }],
        };
      }

      const metadataResult = await fs.writeMetadata(
        assetId,
        "original",
        {
          origin: "watermark",
          created_at: new Date().toISOString(),
          handle: resolvedHandle,
          url: resolvedUrl,
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
        },
        project_slug,
      );
      if (!metadataResult.ok) {
        await fs.deleteAsset(assetId, project_slug).catch(() => undefined);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: metadataResult.error.message }],
        };
      }

      const variantsResult = await writeImageVariants(fs, assetId, buffer, project_slug);
      if (!variantsResult.ok) {
        await fs.deleteAsset(assetId, project_slug).catch(() => undefined);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: variantsResult.error }],
        };
      }

      // Remember the handle so the next watermark dialog defaults to it.
      await recordHandle(resolvedHandle, { saveDefault: save_default }).catch(() => undefined);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ asset_id: assetId, handle: resolvedHandle, url: resolvedUrl }),
        }],
      };
    },
  };
}

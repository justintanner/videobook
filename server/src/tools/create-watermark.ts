import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import sharp from "sharp";
import QRCode from "qrcode";
import type { ToolDef } from "./tool-def.js";
import { writeImageVariants } from "./concat-images.js";
import { recordHandle } from "../watermark-config.js";

const DEFAULT_HANDLE = "justinwtanner";

const QR_SIZE = 240;
const PADDING = 12;
const TEXT_BAND_HEIGHT = 40;
const CARD_WIDTH = QR_SIZE + PADDING * 2;
const CARD_HEIGHT = TEXT_BAND_HEIGHT + QR_SIZE + PADDING * 2;

function defaultUrl(handle: string): string {
  return `https://x.com/${handle}`;
}

function defaultLabel(handle: string): string {
  return `X: ${handle}`;
}

// Render the QR + "X: <handle>" card as a PNG buffer. Identical art to the old
// FFmpeg watermark; now persisted as an img-* asset and composited via OSG.
async function buildCardPng(url: string, label: string): Promise<Buffer> {
  const qrBuffer = await QRCode.toBuffer(url, {
    type: "png",
    margin: 0,
    color: { dark: "#000000", light: "#FFFFFF" },
    errorCorrectionLevel: "M",
    width: QR_SIZE,
  });

  const textImage = await sharp({
    text: {
      text: label,
      font: "Helvetica Bold 22",
      width: CARD_WIDTH - PADDING * 2,
      height: TEXT_BAND_HEIGHT,
      align: "center",
      rgba: true,
    },
  })
    .png()
    .toBuffer();

  return sharp({
    create: {
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([
      { input: textImage, top: PADDING, left: PADDING },
      { input: qrBuffer, top: PADDING + TEXT_BAND_HEIGHT, left: PADDING },
    ])
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
      const resolvedLabel = defaultLabel(resolvedHandle);

      let buffer: Buffer;
      try {
        buffer = await buildCardPng(resolvedUrl, resolvedLabel);
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

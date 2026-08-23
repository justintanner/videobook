import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";
import { recordHandle } from "../watermark-config.js";
import {
  createWatermarkAsset,
  DEFAULT_HANDLE,
  defaultUrl,
} from "../watermark-badge.js";

export function createWatermarkCardDef(engine: Engine): ToolDef {
  return {
    name: "create_watermark_card",
    description:
      "Generate a compact transparent QR + 'X: <handle>' watermark badge and store it as an image artifact. Apply it as a faint floating watermark via apply_watermark, or manually via the on-screen graphic (OSG) settings.",
    schema: {
      book_id: z.string().describe("Book id"),
      handle: z.string().optional().describe(`X handle without @ (default: ${DEFAULT_HANDLE})`),
      url: z.string().optional().describe("URL the QR code resolves to (default: https://x.com/<handle>)"),
      save_default: z
        .boolean()
        .optional()
        .describe("Remember this handle as the default for future watermarks"),
    },
    handler: async (args) => {
      const { handle, url, save_default } = args as {
        book_id: string; handle?: string; url?: string; save_default?: boolean;
      };

      const resolvedHandle = (handle ?? DEFAULT_HANDLE).replace(/^@/, "").trim();
      if (!resolvedHandle) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "handle must be a non-empty string" }],
        };
      }
      const resolvedUrl = url ?? defaultUrl(resolvedHandle);

      const created = await createWatermarkAsset(engine, resolvedHandle, resolvedUrl);
      if (!created.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: created.error }],
        };
      }

      // Remember the handle so the next watermark review defaults to it.
      await recordHandle(resolvedHandle, { saveDefault: save_default }, engine).catch(() => undefined);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ asset_id: created.assetId, handle: resolvedHandle, url: resolvedUrl }),
        }],
      };
    },
  };
}

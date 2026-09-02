import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";
import { recordHandle } from "../watermark-config.js";
import {
  createWatermarkAsset,
  DEFAULT_HANDLE_PADDING,
  DEFAULT_HANDLE_ROUNDING,
  DEFAULT_HANDLE,
  defaultUrl,
  MAX_HANDLE_PADDING,
  MAX_HANDLE_ROUNDING,
  MIN_HANDLE_PADDING,
  MIN_HANDLE_ROUNDING,
} from "../watermark-badge.js";

export function createWatermarkCardDef(engine: Engine): ToolDef {
  return {
    name: "create_watermark_card",
    description:
      "Generate a compact transparent QR plus plain X handle badge and store it as an image artifact. The X icon and handle border are optional, and handle padding X/Y and corner rounding are adjustable. Apply it via apply_watermark or manually through on-screen graphic settings.",
    schema: {
      book_id: z.string().describe("Book id"),
      handle: z.string().optional().describe(`X handle without @ (default: ${DEFAULT_HANDLE})`),
      url: z.string().optional().describe("URL the QR code resolves to (default: https://x.com/<handle>)"),
      save_default: z
        .boolean()
        .optional()
        .describe("Remember this handle as the default for future watermarks"),
      include_x_icon: z
        .boolean()
        .optional()
        .describe("Show the X icon before the plain handle (default true)"),
      include_handle_border: z
        .boolean()
        .optional()
        .describe("Draw a border around the handle pill (default true)"),
      handle_padding: z
        .number()
        .int()
        .min(MIN_HANDLE_PADDING)
        .max(MAX_HANDLE_PADDING)
        .optional()
        .describe(`Horizontal handle padding in reference pixels (default ${DEFAULT_HANDLE_PADDING}; range ${MIN_HANDLE_PADDING}-${MAX_HANDLE_PADDING})`),
      handle_padding_y: z
        .number()
        .int()
        .min(MIN_HANDLE_PADDING)
        .max(MAX_HANDLE_PADDING)
        .optional()
        .describe(`Vertical handle padding in reference pixels (default ${DEFAULT_HANDLE_PADDING}; range ${MIN_HANDLE_PADDING}-${MAX_HANDLE_PADDING})`),
      handle_rounding: z
        .number()
        .int()
        .min(MIN_HANDLE_ROUNDING)
        .max(MAX_HANDLE_ROUNDING)
        .optional()
        .describe(`Handle corner rounding percent (default ${DEFAULT_HANDLE_ROUNDING}; range ${MIN_HANDLE_ROUNDING}-${MAX_HANDLE_ROUNDING})`),
    },
    handler: async (args) => {
      const {
        handle,
        url,
        save_default,
        include_x_icon = true,
        include_handle_border = true,
        handle_padding = DEFAULT_HANDLE_PADDING,
        handle_padding_y = DEFAULT_HANDLE_PADDING,
        handle_rounding = DEFAULT_HANDLE_ROUNDING,
      } = args as {
        book_id: string;
        handle?: string;
        url?: string;
        save_default?: boolean;
        include_x_icon?: boolean;
        include_handle_border?: boolean;
        handle_padding?: number;
        handle_padding_y?: number;
        handle_rounding?: number;
      };

      const resolvedHandle = (handle ?? DEFAULT_HANDLE).replace(/^@/, "").trim();
      if (!resolvedHandle) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "handle must be a non-empty string" }],
        };
      }
      const resolvedUrl = url ?? defaultUrl(resolvedHandle);

      const created = await createWatermarkAsset(engine, resolvedHandle, resolvedUrl, {
        includeXIcon: include_x_icon,
        includeHandleBorder: include_handle_border,
        handlePadding: handle_padding,
        handlePaddingY: handle_padding_y,
        handleRounding: handle_rounding,
      });
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
          text: JSON.stringify({
            asset_id: created.assetId,
            handle: resolvedHandle,
            url: resolvedUrl,
            include_x_icon,
            include_handle_border,
            handle_padding,
            handle_padding_y,
            handle_rounding,
          }),
        }],
      };
    },
  };
}

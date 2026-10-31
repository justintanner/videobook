import type { Engine } from "videobook-engine";
import { z } from "zod";
import { LIGHTNING_WATERMARK_PROFILE } from "../lightning-defaults.js";
import { WATERMARK_PLATFORMS } from "../watermark-platform.js";
import type { WatermarkPlatform } from "../watermark-platform.js";
import type { ToolDef } from "./tool-def.js";
import { normalizeHandle, readWatermarkConfig, recordHandle } from "../watermark-config.js";
import {
  createWatermarkAsset,
  DEFAULT_HANDLE_PADDING,
  DEFAULT_HANDLE_PADDING_Y,
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
      "Make a transparent QR plus X or TikTok handle badge as an image asset, with optional platform icon, border, padding and rounding. Burn it in with apply_watermark.",
    schema: {
      book_id: z.string().describe("Book id"),
      platform: z.enum(WATERMARK_PLATFORMS).optional().describe("Alias platform (default tiktok)"),
      handle: z.string().optional().describe(`X or TikTok alias without @ (X default: ${DEFAULT_HANDLE}; TikTok default: ${LIGHTNING_WATERMARK_PROFILE.handle})`),
      url: z.string().optional().describe("URL the QR code resolves to (default: the selected X or TikTok profile URL)"),
      save_default: z
        .boolean()
        .optional()
        .describe("Remember this handle as the default for future watermarks"),
      include_platform_icon: z
        .boolean()
        .optional()
        .describe("Show the selected platform icon before the plain alias (default true)"),
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
        .describe(`Vertical handle padding in reference pixels (default ${DEFAULT_HANDLE_PADDING_Y}; range ${MIN_HANDLE_PADDING}-${MAX_HANDLE_PADDING})`),
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
        platform = "tiktok",
        include_platform_icon = true,
        include_handle_border = true,
        handle_padding = platform === "tiktok" ? LIGHTNING_WATERMARK_PROFILE.handlePaddingX : DEFAULT_HANDLE_PADDING,
        handle_padding_y = platform === "tiktok" ? LIGHTNING_WATERMARK_PROFILE.handlePaddingY : DEFAULT_HANDLE_PADDING_Y,
        handle_rounding = platform === "tiktok" ? LIGHTNING_WATERMARK_PROFILE.handleRounding : DEFAULT_HANDLE_ROUNDING,
      } = args as {
        book_id: string;
        handle?: string;
        url?: string;
        save_default?: boolean;
        platform?: WatermarkPlatform;
        include_platform_icon?: boolean;
        include_handle_border?: boolean;
        handle_padding?: number;
        handle_padding_y?: number;
        handle_rounding?: number;
      };

      const config = await readWatermarkConfig(engine, platform);
      const fallbackHandle = platform === "x"
        ? DEFAULT_HANDLE
        : config.savedHandle ?? config.recent[0] ?? (platform === "tiktok" ? LIGHTNING_WATERMARK_PROFILE.handle : "");
      const resolvedHandle = normalizeHandle(handle ?? fallbackHandle);
      if (!resolvedHandle) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "handle must be a non-empty string" }],
        };
      }
      const resolvedUrl = url ?? defaultUrl(resolvedHandle, platform);

      const created = await createWatermarkAsset(engine, resolvedHandle, resolvedUrl, {
        platform,
        includePlatformIcon: include_platform_icon,
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
      await recordHandle(resolvedHandle, { saveDefault: save_default, platform }, engine).catch(() => undefined);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            asset_id: created.assetId,
            handle: resolvedHandle,
            url: resolvedUrl,
            platform,
            include_platform_icon,
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

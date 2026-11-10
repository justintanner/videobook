import { WATERMARK_LOGO_PATHS } from "../watermark-platform.js";
import type { GraphicsIcon } from "./model.js";

export const GRAPHICS_ICON_VIEWBOX = 24;

export const GRAPHICS_ICON_PATHS: Readonly<Record<GraphicsIcon, string>> = {
  camera: "M8.5 4h7l1.5 3H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3ZM12 9.5a4 4 0 1 0 0 8 4 4 0 1 0 0-8Zm0 2a2 2 0 1 1 0 4 2 2 0 1 1 0-4Z",
  link: "M6 7h2a5 5 0 0 1 0 10H6A5 5 0 0 1 6 7Zm0 2.5a2.5 2.5 0 0 0 0 5h2a2.5 2.5 0 0 0 0-5H6Zm10-2.5h2a5 5 0 0 1 0 10h-2a5 5 0 0 1 0-10Zm0 2.5a2.5 2.5 0 0 0 0 5h2a2.5 2.5 0 0 0 0-5h-2Z",
  music: "M10 3.5 18 2v4l-6 1.2V17a3.5 3.5 0 1 1-2-3.16V3.5Z",
  pin: "M12 2a7 7 0 0 1 7 7c0 5.25-7 13-7 13S5 14.25 5 9a7 7 0 0 1 7-7Zm0 4.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z",
  tiktok: WATERMARK_LOGO_PATHS.tiktok,
  x: WATERMARK_LOGO_PATHS.x,
};

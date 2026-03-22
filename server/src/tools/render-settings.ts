import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";
import { readRenderSettings, RENDER_ORIENTATIONS } from "./sync.js";

export function renderSettingsDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "render_settings",
    description: "Fetch stored render settings for a single asset across all orientations",
    schema: {
      asset_id: z.string().describe("Asset ID (e.g. vid-running-dog)"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { asset_id, project_slug } = args as { asset_id: string; project_slug: string };
      const settings = await readRenderSettings(fs, asset_id, project_slug, [...RENDER_ORIENTATIONS]);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(settings) }],
      };
    },
  };
}

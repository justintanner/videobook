import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import type { Orientation } from "../remotion/subtitles/types.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

type TimelineSlot = {
  slug: string;
  volume?: number;
  audioFadeIn?: number;
  audioFadeOut?: number;
};

type ViewerSize = 'landscape' | 'portrait' | 'square' | 'original';

type TimelineConfig = {
  slots: TimelineSlot[];
  render: Orientation;
  currentOrientation?: ViewerSize;
};

function toolError(msg: string): ToolResult {
  return { isError: true as const, content: [{ type: "text" as const, text: msg }] };
}

export function assignSlotDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "assign_slot",
    description: "Assign an asset to a timeline slot (e.g. slot 's02' = index 1)",
    schema: {
      project_slug: z.string().describe("Project slug"),
      asset_id: z.string().describe("Asset ID to assign to the slot"),
      slot: z.string().describe("Slot identifier like 's02' (@ prefix already stripped)"),
    },
    handler: async (args) => {
      const { project_slug, asset_id, slot } = args as {
        project_slug: string;
        asset_id: string;
        slot: string;
      };

      // Parse slot index from e.g. "s02" → 1
      const match = slot.match(/^s(\d+)$/);
      if (!match) {
        return toolError(`Invalid slot format: "${slot}". Expected format like "s01", "s02", etc.`);
      }
      const index = parseInt(match[1], 10) - 1;
      if (index < 0) {
        return toolError(`Slot index must be >= 1, got "${slot}"`);
      }

      // Validate asset exists
      const assets = await fs.listAssets(project_slug);
      const assetIds = new Set(assets.map((a: { id: string }) => a.id));
      if (!assetIds.has(asset_id)) {
        return toolError(`Asset "${asset_id}" not found in project "${project_slug}"`);
      }

      // Read current timeline (default to empty)
      const readResult = await fs.readProjectMeta<TimelineConfig | TimelineSlot[]>("timeline", project_slug);

      if (!readResult.ok && readResult.error.code !== "NOT_FOUND") {
        return toolError(readResult.error.message);
      }
      const config: TimelineConfig = !readResult.ok
        ? { slots: [], render: "landscape" }
        : Array.isArray(readResult.value)
          ? { slots: readResult.value, render: "landscape" }
          : {
              ...readResult.value,
              render: Array.isArray(readResult.value.render)
                ? ((readResult.value.render as unknown as string[])[0] ?? "landscape") as Orientation
                : readResult.value.render,
            };

      // Pad slots array if needed
      while (config.slots.length <= index) {
        config.slots.push({ slug: "" });
      }

      // Assign asset to slot (preserve existing volume/fade)
      config.slots[index] = { ...config.slots[index], slug: asset_id };

      // Write back
      const writeResult = await fs.writeProjectMeta("timeline", config, project_slug);
      if (!writeResult.ok) {
        return toolError(writeResult.error.message);
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(config) }],
      };
    },
  };
}

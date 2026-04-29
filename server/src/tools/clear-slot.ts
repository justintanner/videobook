import type { ClipfirstFs } from "clipfirst-engine";
import { z } from "zod";
import type { Orientation } from "../remotion/subtitles/types.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

type TimelineSlot = {
  slug: string;
  volume?: number;
  audioFadeIn?: number;
  audioFadeOut?: number;
};

type TimelineAudioClip = {
  id: string;
  slug: string;
  startFrame: number;
  durationFrames: number;
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
};

type ViewerSize = 'landscape' | 'portrait' | 'square' | 'original';

type TimelineConfig = {
  slots: TimelineSlot[];
  audio?: TimelineAudioClip[];
  render: Orientation;
  currentOrientation?: ViewerSize;
};

function toolError(msg: string): ToolResult {
  return { isError: true as const, content: [{ type: "text" as const, text: msg }] };
}

function normalizeConfig(raw: TimelineConfig | TimelineSlot[]): TimelineConfig {
  if (Array.isArray(raw)) return { slots: raw, render: "landscape" };
  return {
    ...raw,
    render: Array.isArray(raw.render)
      ? ((raw.render as unknown as string[])[0] ?? "landscape") as Orientation
      : raw.render,
  };
}

export function clearSlotDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "unassign_slot",
    description: "Clear an asset from a timeline slot (e.g. slot 's02' = index 1)",
    schema: {
      project_slug: z.string().describe("Project slug"),
      slot: z.string().describe("Slot identifier like 's02' (@ prefix already stripped)"),
    },
    handler: async (args) => {
      const { project_slug, slot } = args as {
        project_slug: string;
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

      // Read current timeline
      const readResult = await fs.readProjectMeta<TimelineConfig | TimelineSlot[]>("timeline", project_slug);
      let config: TimelineConfig;
      if (readResult.ok) {
        config = normalizeConfig(readResult.value);
      } else {
        const err = (readResult as { ok: false; error: { code: string; message: string } }).error;
        if (err.code === "NOT_FOUND") {
          return toolError("No timeline exists for this project");
        }
        return toolError(err.message);
      }

      if (index >= config.slots.length) {
        return toolError(`Slot index ${index + 1} is out of range (timeline has ${config.slots.length} slots)`);
      }

      // Clear the slot (full reset including volume/fade)
      config.slots[index] = { slug: "" };

      // Write back
      const writeResult = await fs.writeProjectMeta("timeline", config, project_slug);
      if (writeResult.ok) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(config) }],
        };
      }
      const writeErr = (writeResult as { ok: false; error: { message: string } }).error;
      return toolError(writeErr.message);
    },
  };
}

import type { VideocityFs } from "videocity-engine";
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

type ViewerSize = "landscape" | "portrait" | "square" | "original";

type TimelineConfig = {
  slots: TimelineSlot[];
  audio?: TimelineAudioClip[];
  render: Orientation;
  currentOrientation?: ViewerSize;
};

function toolError(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
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

function slotIndex(slot: string): number | null {
  const match = slot.match(/^s(\d+)$/);
  if (!match) return null;
  const index = Number.parseInt(match[1], 10) - 1;
  return index >= 0 ? index : null;
}

function trimTrailingEmptySlots(slots: TimelineSlot[]): number {
  let removed = 0;
  while (slots.length > 0 && !slots[slots.length - 1]?.slug) {
    slots.pop();
    removed++;
  }
  return removed;
}

export function removeTimelineSlotDef(fs: VideocityFs): ToolDef {
  return {
    name: "remove_timeline_slot",
    description: "Remove a stored timeline slot, shift later slots left, and discard redundant trailing empty slots",
    schema: {
      project_slug: z.string().describe("Project slug"),
      slot: z.string().describe("Stored slot identifier like 's02' (@ prefix already stripped)"),
    },
    handler: async (args) => {
      const { project_slug, slot } = args as {
        project_slug: string;
        slot: string;
      };

      const index = slotIndex(slot);
      if (index === null) {
        return toolError(`Invalid slot format: "${slot}". Expected format like "s01", "s02", etc.`);
      }

      const readResult = await fs.readProjectMeta<TimelineConfig | TimelineSlot[]>("timeline", project_slug);
      if (!readResult.ok) {
        if (readResult.error.code === "NOT_FOUND") {
          return toolError("No timeline exists for this project");
        }
        return toolError(readResult.error.message);
      }

      const config = normalizeConfig(readResult.value);
      if (index >= config.slots.length) {
        return toolError(`Slot index ${index + 1} is out of range (timeline has ${config.slots.length} stored slots)`);
      }

      const [removedSlot] = config.slots.splice(index, 1);
      const trimmedTrailingSlots = trimTrailingEmptySlots(config.slots);
      const writeResult = await fs.writeProjectMeta("timeline", config, project_slug);
      if (!writeResult.ok) return toolError(writeResult.error.message);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ...config,
            removed_slot: slot,
            removed_asset_id: removedSlot.slug || null,
            trimmed_trailing_slots: trimmedTrailingSlots,
          }),
        }],
      };
    },
  };
}

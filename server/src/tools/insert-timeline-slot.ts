import type { Engine } from "videobook-engine";
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

export function insertTimelineSlotDef(fs: Engine): ToolDef {
  return {
    name: "insert_timeline_slot",
    description: "Insert an empty timeline slot before or after a slot identifier",
    schema: {
      project_slug: z.string().describe("Project slug"),
      slot: z.string().describe("Slot identifier like 's02' (@ prefix already stripped)"),
      position: z.enum(["before", "after"]).describe("Where to insert the empty slot"),
    },
    handler: async (args) => {
      const { project_slug, slot, position } = args as {
        project_slug: string;
        slot: string;
        position: "before" | "after";
      };

      const index = slotIndex(slot);
      if (index === null) {
        return toolError(`Invalid slot format: "${slot}". Expected format like "s01", "s02", etc.`);
      }

      const readResult = await fs.metadata.projects.read<TimelineConfig | TimelineSlot[]>("timeline", project_slug);
      let config: TimelineConfig;
      if (readResult.ok) {
        config = normalizeConfig(readResult.value);
      } else if (readResult.error.code === "NOT_FOUND") {
        config = { slots: [], render: "landscape" };
      } else {
        return toolError(readResult.error.message);
      }

      while (config.slots.length <= index) {
        config.slots.push({ slug: "" });
      }
      const insertionIndex = position === "before" ? index : index + 1;
      config.slots.splice(insertionIndex, 0, { slug: "" });

      const writeResult = await fs.metadata.projects.write("timeline", config, project_slug);
      if (!writeResult.ok) return toolError(writeResult.error.message);
      return {
        content: [{ type: "text", text: JSON.stringify(config) }],
      };
    },
  };
}

import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import { readClipShowPlan, writeClipShowPlan } from "../plan-clip-show.js";
import { normalizeTreatment } from "../clip-show-osg-types.js";
import type { ClipShowOsg, ClipShowPlanSidecar, ClipShowSegment } from "../plan-types.js";
import type { ToolDef } from "./tool-def.js";

// Structural, GPT-free edits to the active Clip Show plan: one op per call,
// addressed by segment_index (the joke) and, for OSG ops, osg_index. A plain
// read-modify-write through readClipShowPlan/writeClipShowPlan.
const OPS = [
  "set_joke", // joke / joke_notes text
  "set_audio", // audio_asset_id (aud-* or null to clear)
  "set_osg_field", // caption / treatment / duration_ms / beat_text
  "swap_osg_image", // point an OSG at an uploaded img-*
  "add_osg", // append an upload OSG to a joke's run
  "remove_osg",
  "reorder_osg", // move osg_index → to_index within the joke
  "remove_joke",
  "reorder_joke", // move segment_index → to_index
] as const;

const schema = {
  project_slug: z.string().describe("Project slug"),
  op: z.enum(OPS).describe("Edit operation to perform"),
  segment_index: z.number().int().min(0).describe("Zero-based joke (segment) index"),
  osg_index: z.number().int().min(0).optional().describe("Zero-based OSG index within the joke (for OSG ops)"),
  to_index: z.number().int().min(0).optional().describe("Destination index for reorder ops"),
  joke: z.string().optional().describe("Updated spoken joke text (set_joke)"),
  joke_notes: z.string().optional().describe("Updated comedic-angle note (set_joke)"),
  audio_asset_id: z.string().nullable().optional().describe("aud-* voiceover asset, or null to clear (set_audio)"),
  image_asset_id: z.string().optional().describe("img-* image to use (swap_osg_image / add_osg)"),
  treatment: z.string().optional().describe("OSG treatment id (set_osg_field / add_osg)"),
  caption: z.string().nullable().optional().describe("OSG caption, or null (set_osg_field / add_osg)"),
  beat_text: z.string().optional().describe("OSG beat text (set_osg_field / add_osg)"),
  duration_ms: z.number().int().optional().describe("OSG hold duration in ms (set_osg_field / add_osg)"),
};

type Args = {
  project_slug: string;
  op: (typeof OPS)[number];
  segment_index: number;
  osg_index?: number;
  to_index?: number;
  joke?: string;
  joke_notes?: string;
  audio_asset_id?: string | null;
  image_asset_id?: string;
  treatment?: string;
  caption?: string | null;
  beat_text?: string;
  duration_ms?: number;
};

function stripAt(value: string): string {
  return value.replace(/^@/, "").trim();
}

function clampDuration(ms: number): number {
  if (!Number.isFinite(ms)) return 1500;
  return Math.min(4000, Math.max(500, Math.round(ms)));
}

function move<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length) return items;
  const next = items.slice();
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, item);
  return next;
}

function requireImg(value: string | undefined): string {
  if (!value) throw new Error("image_asset_id is required");
  const id = stripAt(value);
  if (!id.startsWith("img-")) throw new Error(`image_asset_id must be an img-* asset, got: ${id}`);
  return id;
}

function applyOsgPatch(osg: ClipShowOsg, args: Args): ClipShowOsg {
  return {
    ...osg,
    ...(args.treatment !== undefined ? { treatment: normalizeTreatment(args.treatment) } : {}),
    ...(args.caption !== undefined ? { caption: args.caption && args.caption.trim() ? args.caption.trim() : null } : {}),
    ...(args.beat_text !== undefined ? { beat_text: args.beat_text.trim() } : {}),
    ...(args.duration_ms !== undefined ? { duration_ms: clampDuration(args.duration_ms) } : {}),
  };
}

// Apply one op to a single joke (segment). Returns the new segment.
function editSegment(segment: ClipShowSegment, args: Args): ClipShowSegment {
  switch (args.op) {
    case "set_joke":
      return {
        ...segment,
        ...(args.joke !== undefined ? { joke: args.joke.trim() } : {}),
        ...(args.joke_notes !== undefined ? { joke_notes: args.joke_notes.trim() } : {}),
      };
    case "set_audio":
      return {
        ...segment,
        audio_asset_id: args.audio_asset_id === undefined ? segment.audio_asset_id : args.audio_asset_id ? stripAt(args.audio_asset_id) : null,
      };
    case "add_osg": {
      const imageId = requireImg(args.image_asset_id);
      const osg: ClipShowOsg = {
        source: "upload",
        image_asset_id: imageId,
        image_prompt: null,
        treatment: normalizeTreatment(args.treatment),
        beat_text: args.beat_text?.trim() ?? "",
        caption: args.caption && args.caption.trim() ? args.caption.trim() : null,
        duration_ms: args.duration_ms !== undefined ? clampDuration(args.duration_ms) : 1500,
      };
      return { ...segment, osgs: [...segment.osgs, osg] };
    }
    case "remove_osg": {
      if (args.osg_index === undefined) throw new Error("osg_index is required");
      if (segment.osgs.length <= 1) throw new Error("A joke must keep at least one OSG");
      return { ...segment, osgs: segment.osgs.filter((_, i) => i !== args.osg_index) };
    }
    case "reorder_osg": {
      if (args.osg_index === undefined || args.to_index === undefined) throw new Error("osg_index and to_index are required");
      return { ...segment, osgs: move(segment.osgs, args.osg_index, args.to_index) };
    }
    case "set_osg_field": {
      if (args.osg_index === undefined) throw new Error("osg_index is required");
      const osg = segment.osgs[args.osg_index];
      if (!osg) throw new Error(`OSG ${args.osg_index} not found`);
      return { ...segment, osgs: segment.osgs.map((o, i) => (i === args.osg_index ? applyOsgPatch(o, args) : o)) };
    }
    case "swap_osg_image": {
      if (args.osg_index === undefined) throw new Error("osg_index is required");
      const osg = segment.osgs[args.osg_index];
      if (!osg) throw new Error(`OSG ${args.osg_index} not found`);
      const imageId = requireImg(args.image_asset_id);
      const swapped: ClipShowOsg = { ...osg, source: "upload", image_asset_id: imageId, image_prompt: null };
      return { ...segment, osgs: segment.osgs.map((o, i) => (i === args.osg_index ? swapped : o)) };
    }
    default:
      throw new Error(`Unsupported segment op: ${args.op}`);
  }
}

export function replacePlanClipShowAssetDef(fs: VideocityFs): ToolDef {
  return {
    name: "replace_plan_clip_show_asset",
    description:
      "Structurally edit the active Clip Show plan (no GPT): set a joke's text or voiceover, edit/add/remove/reorder its on-screen graphics (OSGs), swap an OSG image to an uploaded img-*, or remove/reorder a whole joke. One op per call. Writes plan/index.md and plan/.plan.json.",
    schema,
    handler: async (rawArgs) => {
      const args = rawArgs as Args;
      try {
        const sidecar = await readClipShowPlan(fs, args.project_slug);
        const segment = sidecar.segments[args.segment_index];
        if (!segment) throw new Error(`Clip Show joke ${args.segment_index} not found`);
        if (!Array.isArray(segment.osgs)) {
          throw new Error("This Clip Show plan uses the old format — regenerate it from /templates before editing.");
        }

        let next: ClipShowPlanSidecar;
        if (args.op === "remove_joke") {
          if (sidecar.segments.length <= 1) throw new Error("A plan must keep at least one joke");
          next = { ...sidecar, segments: sidecar.segments.filter((_, i) => i !== args.segment_index) };
        } else if (args.op === "reorder_joke") {
          if (args.to_index === undefined) throw new Error("to_index is required");
          next = { ...sidecar, segments: move(sidecar.segments, args.segment_index, args.to_index) };
        } else {
          const edited = editSegment(segment, args);
          next = { ...sidecar, segments: sidecar.segments.map((s, i) => (i === args.segment_index ? edited : s)) };
        }

        await writeClipShowPlan(fs, args.project_slug, next);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ asset_id: "plan", sidecar: next }) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: msg }],
        };
      }
    },
  };
}

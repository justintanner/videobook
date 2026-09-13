import type { Command } from "./video-editing-command-contract.js";

type Parameter = Command["params"][number];

const text = (name: string, description: string, required = true): Parameter => ({ name, description, required, type: "string" });
const number = (name: string, description: string, required = true): Parameter => ({ name, description, required, type: "number" });
const clip = text("clip_id", "Sequence clip; choose from the current sequence");
const track = text("track_id", "Sequence track");
const media = text("asset_id", "Source media or notebook address, such as @a1");
const start = number("start_frame", "Start frame in the sequence, beginning at zero");
const duration = number("duration_frames", "Duration in frames");

function command(name: string, description: string, params: Parameter[] = [], example?: string): Command {
  return {
    command: name, description, params, example: example ?? name, category: "action",
    icon: "Play", size: "default", variant: "default", chevron: "right", exposure: "composite",
  };
}

export const APPLICATION_COMMANDS: Command[] = [
  command("/caption", "Preview a sequence caption with timing and style", [start, duration, text("style", "clean, bold or high-contrast"), text("text", "Caption text")], "/caption 0 90 clean Opening scene"),
  command("/duck", "Lower background audio beneath a narration clip", [text("narration_clip_id", "Narration clip"), number("reduction_db", "Reduction from -36 to -1 dB; default -12", false)]),
  command("/fit", "Fit, fill or crop a visual sequence clip", [clip, text("mode", "fit, fill or crop")]),
  command("/gap", "Preview removing a gap from the sequence", [start, duration, { ...track, required: false }]),
  command("/generate-cell", "Review generation for a configured notebook cell", [text("cell_id", "Generation cell, such as @a1")], "/generate-cell @a1"),
  command("/insert", "Preview inserting media into the sequence", [media, start, { ...duration, required: false }], "/insert @a1 0 90"),
  command("/move", "Preview moving a sequence clip to a track and frame", [clip, track, start]),
  command("/overwrite", "Preview overwriting sequence content with media", [media, start, { ...duration, required: false }], "/overwrite @a1 0 90"),
  command("/reframe", "Preview a crop transform for a visual sequence clip", [clip]),
  command("/rough-cut", "Review a rough cut built from notebook media"),
  command("/sound-effects", "Review suggested sound effects for the sequence"),
  command("/track-add", "Add a video, audio or caption track", [text("kind", "video, audio or caption"), text("name", "Display name", false)], "/track-add audio Music"),
  command("/track-remove", "Remove an empty sequence track", [track]),
  command("/volume", "Preview a sequence clip's audio gain", [clip, number("gain_db", "Audio gain from -96 to 24 dB")]),
  command("/clip-delete", "Preview deleting a sequence clip while retaining its source media", [clip, text("ripple", "Use --ripple to close the gap", false)]),
  command("/clip-reverse", "Preview reversing a sequence clip while retaining its source media", [clip]),
  command("/clip-trim", "Preview trimming a sequence clip in frames", [clip, start, duration]),
  command("/export-sequence", "Review and export the current sequence", [text("aspect", "16:9, 9:16 or 1:1", false), text("captions", "burned, sidecar or omit", false)], "/export-sequence --aspect 16:9 --captions burned"),
];

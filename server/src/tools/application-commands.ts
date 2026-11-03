import type { Command } from "./video-editing-command-contract.js";

type Parameter = Command["params"][number];

const text = (name: string, description: string, required = true): Parameter => ({ name, description, required, type: "string" });
const number = (name: string, description: string, required = true): Parameter => ({ name, description, required, type: "number" });
const clip = text("clip_id", "Sequence clip; choose from the current sequence");
const track = text("track_id", "Sequence track");
const media = text("asset_id", "Source media or notebook address, such as @a1");
const start = number("start_frame", "Start frame in the sequence, beginning at zero");
const duration = number("duration_frames", "Duration in frames");

function command(name: string, description: string, params: Parameter[] = [], example?: string, aliases: string[] = []): Command {
  return {
    command: name, description, params, example: example ?? name, category: "action",
    icon: "Play", size: "default", variant: "default", chevron: "right", exposure: "composite", aliases,
  };
}

export const APPLICATION_COMMANDS: Command[] = [
  command("/caption", "Preview a sequence caption with timing and style", [start, duration, text("style", "clean, bold or high-contrast"), text("text", "Caption text")], "/caption 0 90 clean Opening scene"),
  command("/duck", "Lower background audio beneath a narration clip", [text("narration_clip_id", "Narration clip"), number("reduction_db", "Reduction from -36 to -1 dB; default -12", false)]),
  command("/fit", "Fit, fill or crop a visual sequence clip", [clip, text("mode", "fit, fill or crop")]),
  command("/gap", "Preview inserting a gap that shifts later clips forward", [start, duration, { ...track, required: false }]),
  command("/insert", "Preview inserting media into the sequence", [media, start, { ...duration, required: false }], "/insert @a1 0 90", ["/assign", "/audio-add"]),
  command("/move", "Preview moving a sequence clip to a track and frame", [clip, track, start], undefined, ["/audio-move"]),
  command("/overwrite", "Preview overwriting sequence content with media", [media, start, { ...duration, required: false }], "/overwrite @a1 0 90"),
  command("/rough-cut", "Review a rough cut built from notebook media"),
  command("/track-add", "Add a video, audio or caption track", [text("kind", "video, audio or caption"), text("name", "Display name", false)], "/track-add audio Music"),
  command("/track-remove", "Remove an empty sequence track", [track]),
  command("/clip-audio", "Edit a sequence audio clip's gain, mute, or fades", [clip, text("field", "gain, mute, fade-in, or fade-out"), text("value", "Gain from -96 to 24 dB, on or off, or fade length in frames")], "/clip-audio @clip-id gain -6", ["/volume", "/audio-set"]),
  command("/export", "Review and export the current sequence", [text("aspect", "16:9, 9:16 or 1:1", false), text("captions", "burned, sidecar or omit", false)], "/export --aspect 16:9 --captions burned", ["/export-sequence", "/final"]),
];

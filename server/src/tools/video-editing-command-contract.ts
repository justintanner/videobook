type CommandParam = {
  name: string;
  type: "string" | "number" | "boolean" | "string[]";
  required: boolean;
  description: string;
  consumeRest?: boolean;
};

type CommandExposure = "direct" | "ui" | "composite" | "internal";

export const COMMAND_ADAPTER_NAMES = [
  "apply_cuts",
  "apply_sfx",
  "change_speed",
  "duplicate",
  "keywords",
  "qr_outro",
  "sync_audio",
  "timewarp",
  "translate_subtitles",
  "trim",
] as const;

type CommandAdapterName = typeof COMMAND_ADAPTER_NAMES[number];

export type Command = {
  command: string;
  description: string;
  example?: string;
  category: "action" | "project" | "context_menu" | "viewer";
  icon: string;
  size: "sm" | "default" | "lg";
  variant: "default" | "violet" | "fuchsia" | "blue" | "zinc" | "amber" | "emerald" | "pink";
  chevron: "right" | "down";
  params: CommandParam[];
  mcpTool?: {
    tool: string;
    adapter?: CommandAdapterName;
    autoInject?: string[];
    injectParams?: Record<string, string | number | boolean>;
  };
  uiAction?: string;
  exposure?: Exclude<CommandExposure, "internal">;
  canonical?: string;
  aliases?: string[];
  deprecated?: boolean;
};

type VideoEditingToolContract = {
  tool: string;
  exposure: CommandExposure;
  purpose: string;
  command?: string;
  replacement?: string;
};

export const VIDEO_EDITING_COMMANDS: Command[] = [
  {
    command: "/trim-video",
    description: "Trim video clip",
    example: "/trim-video @hero-intro 0:05 0:12",
    category: "action",
    icon: "Scissors",
    size: "lg",
    variant: "default",
    chevron: "right",
    params: [
      { name: "asset_id", type: "string", required: true, description: "Asset to trim" },
      { name: "start", type: "string", required: false, description: "Start timestamp" },
      { name: "end", type: "string", required: false, description: "End timestamp" },
    ],
    mcpTool: { tool: "trim_video", adapter: "trim", autoInject: ["book_id"] },
    exposure: "direct",
    aliases: ["/trim"],
  },
  {
    command: "/trim-audio",
    description: "Trim audio clip",
    example: "/trim-audio @aud-voiceover-main 0:00 0:30",
    category: "action",
    icon: "Scissors",
    size: "default",
    variant: "emerald",
    chevron: "right",
    params: [
      { name: "asset_id", type: "string", required: true, description: "Audio asset to trim (aud-*)" },
      { name: "start", type: "string", required: false, description: "Start timestamp" },
      { name: "end", type: "string", required: false, description: "End timestamp" },
    ],
    mcpTool: { tool: "trim_audio", adapter: "trim", autoInject: ["book_id"] },
    exposure: "direct",
    aliases: [],
  },
  {
    command: "/split-chunks",
    description: "Split a video into targeted chunks plus a leftover while preserving the source",
    example: "/split-chunks @vid-source 10 15",
    category: "context_menu",
    icon: "Scissors",
    size: "default",
    variant: "violet",
    chevron: "right",
    params: [
      { name: "asset_id", type: "string", required: true, description: "Video asset to split" },
      { name: "target_secs", type: "string[]", required: false, description: "Ordered chunk lengths (default 7 seconds)" },
    ],
    mcpTool: { tool: "split_video_by_durations", autoInject: ["book_id"] },
    exposure: "direct",
    aliases: ["/even-split"],
  },
  {
    command: "/overlay",
    description: "Place an on-screen graphic overlay on a video",
    example: "/overlay @vid-yt-clip @img-logo",
    category: "context_menu",
    icon: "Tv",
    size: "default",
    variant: "default",
    chevron: "right",
    params: [
      { name: "asset_id", type: "string", required: true, description: "Video asset to overlay" },
      { name: "image", type: "string", required: false, description: "Image asset to use as the overlay" },
    ],
    uiAction: "open_osg",
    exposure: "ui",
    aliases: ["/osg"],
  },
  {
    command: "/apply-cuts",
    description: "Apply trim cuts to a video clip in place",
    example: "/apply-cuts @vid-clip 0-5 10-15",
    category: "action",
    icon: "Scissors",
    size: "default",
    variant: "violet",
    chevron: "right",
    params: [
      { name: "asset_id", type: "string", required: true, description: "Video asset ID" },
      { name: "cuts", type: "string[]", required: true, description: "Cut ranges, e.g. 0-5 10-15" },
    ],
    mcpTool: { tool: "apply_cuts", adapter: "apply_cuts", autoInject: ["book_id"] },
    exposure: "direct",
    aliases: [],
  },
  {
    command: "/extract-frame",
    description: "Extract a frame at a specific timestamp from a video as an image asset",
    example: "/extract-frame @vid-clip 2.5",
    category: "context_menu",
    icon: "Image",
    size: "default",
    variant: "default",
    chevron: "right",
    params: [
      { name: "asset_id", type: "string", required: true, description: "Video asset to extract from" },
      { name: "timestamp", type: "number", required: true, description: "Timestamp in seconds" },
    ],
    mcpTool: { tool: "extract_frame", autoInject: ["book_id"] },
    exposure: "direct",
    aliases: [],
  },
  {
    command: "/transcript",
    description: "Read transcript of a video or audio asset",
    example: "/transcript @vid-interview",
    category: "action",
    icon: "FileText",
    size: "default",
    variant: "violet",
    chevron: "right",
    params: [
      { name: "asset_id", type: "string", required: true, description: "Asset ID to read transcript for" },
    ],
    mcpTool: { tool: "read_transcript", autoInject: ["book_id"] },
    exposure: "direct",
    aliases: [],
  },
  {
    command: "/translate-subs",
    description: "Translate video subtitles to a target language",
    example: "/translate-subs @vid-clip es",
    category: "action",
    icon: "Languages",
    size: "default",
    variant: "violet",
    chevron: "right",
    params: [
      { name: "asset_id", type: "string", required: true, description: "Video asset ID" },
      { name: "target_language", type: "string", required: true, description: "Two-letter target language code" },
    ],
    mcpTool: { tool: "translate_subtitles", adapter: "translate_subtitles", autoInject: ["book_id"] },
    exposure: "direct",
    aliases: [],
  },
  {
    command: "/final",
    description: "Finalize and export the project timeline",
    example: "/final portrait",
    category: "action",
    icon: "Clapperboard",
    size: "default",
    variant: "default",
    chevron: "right",
    params: [
      { name: "orientation", type: "string", required: false, description: "landscape, portrait, or square (default: active tab)" },
    ],
    mcpTool: { tool: "render_timeline", autoInject: ["book_id"] },
    exposure: "direct",
    aliases: [],
  },
  {
    command: "/render-video",
    description: "Render a video asset",
    example: "/render-video @hero-intro portrait",
    category: "action",
    icon: "Film",
    size: "lg",
    variant: "violet",
    chevron: "right",
    params: [
      { name: "asset_id", type: "string", required: true, description: "Video asset to render" },
      { name: "orientation", type: "string", required: false, description: "landscape, portrait, or square (default: all)" },
    ],
    mcpTool: { tool: "render_video", autoInject: ["book_id"] },
    exposure: "direct",
    aliases: ["/render"],
  },
  {
    command: "/audio-settings",
    description: "Audio viewer settings for volume and fades",
    example: "/audio-settings volume 80",
    category: "viewer",
    icon: "volume-2",
    size: "sm",
    variant: "default",
    chevron: "right",
    params: [
      { name: "field", type: "string", required: true, description: "volume, fade-in, or fade-out" },
      { name: "value", type: "string", required: false, description: "Numeric value" },
    ],
    uiAction: "settings_audio",
    exposure: "ui",
    aliases: ["/audio"],
  },
];

export const VIDEO_EDITING_TOOL_CONTRACTS: VideoEditingToolContract[] = [
  { tool: "trim_video", exposure: "direct", command: "/trim-video", purpose: "Keep or remove a time range from video" },
  { tool: "trim_audio", exposure: "direct", command: "/trim-audio", purpose: "Keep or remove a time range from audio" },
  { tool: "split_video", exposure: "composite", command: "/split", purpose: "Create and run two notebook split branches" },
  { tool: "split_video_by_durations", exposure: "direct", command: "/split-chunks", purpose: "Split video into target-duration chunks" },
  { tool: "pad_video", exposure: "direct", command: "/pad", purpose: "Append black frames and silence" },
  { tool: "crop_video", exposure: "ui", command: "/crop", purpose: "Interactive video crop" },
  { tool: "crop_image", exposure: "ui", command: "/crop", purpose: "Interactive image crop" },
  { tool: "invert_image", exposure: "direct", command: "/invert", purpose: "Invert image colors" },
  { tool: "set_video_overlay", exposure: "ui", command: "/overlay", purpose: "Configure an on-screen graphic" },
  { tool: "animate_keywords", exposure: "direct", command: "/keywords", purpose: "Configure transcript-timed keyword graphics" },
  { tool: "detect_scenes", exposure: "direct", command: "/detect-scenes", purpose: "Detect visual scene boundaries" },
  { tool: "suggest_cuts", exposure: "direct", command: "/suggest-cuts", purpose: "Suggest removable video ranges" },
  { tool: "analyze_jokes", exposure: "direct", command: "/analyze-jokes", purpose: "Analyze edit points around jokes" },
  { tool: "suggest_sfx", exposure: "direct", command: "/suggest-sfx", purpose: "Suggest sound-effect placements" },
  { tool: "apply_cuts", exposure: "direct", command: "/apply-cuts", purpose: "Remove one or more video ranges" },
  { tool: "apply_sfx", exposure: "direct", command: "/apply-sfx", purpose: "Generate and mix sound effects" },
  { tool: "inject_first_frame", exposure: "direct", command: "/inject-first-frame", purpose: "Replace frame zero with an image" },
  { tool: "extract_first_frame", exposure: "direct", command: "/extract-first-frame", purpose: "Extract the first video frame" },
  { tool: "extract_last_frame", exposure: "direct", command: "/extract-last-frame", purpose: "Extract the last video frame" },
  { tool: "extract_frame", exposure: "direct", command: "/extract-frame", purpose: "Extract a frame at a timestamp" },
  { tool: "extract_notebook_frame", exposure: "internal", purpose: "Extract a frame from a video cell into a new image cell" },
  { tool: "extract_notebook_audio", exposure: "internal", purpose: "Extract audio from a video cell into a new audio cell" },
  { tool: "extract_video_clip", exposure: "internal", purpose: "Extract a notebook video clip" },
  { tool: "extract_audio", exposure: "direct", command: "/extract-audio", purpose: "Extract a video soundtrack" },
  { tool: "make_cover_song", exposure: "direct", command: "/make-cover-song", purpose: "Make an exact-duration instrumental cover from video or audio" },
  { tool: "extend_audio_asset", exposure: "direct", command: "/extend-audio", purpose: "Extend an audio asset" },
  { tool: "remove_sound", exposure: "direct", command: "/remove-sound", purpose: "Remove a described sound" },
  { tool: "audio_boost", exposure: "direct", command: "/audio-boost", purpose: "Increase audio volume" },
  { tool: "audio_mix", exposure: "direct", command: "/audio-mix", purpose: "Mix an audio layer into an asset" },
  { tool: "replace_video_audio", exposure: "direct", command: "/replace-audio", purpose: "Replace a video soundtrack" },
  { tool: "splice_video", exposure: "direct", command: "/splice", purpose: "Splice two or more videos" },
  { tool: "smooth_scene_concat", exposure: "direct", command: "/scene-concat", purpose: "Join scenes with aligned audio" },
  { tool: "reverse_video", exposure: "direct", command: "/reverse", purpose: "Reverse video playback" },
  { tool: "change_video_speed", exposure: "direct", command: "/speed", purpose: "Change playback speed or duration" },
  { tool: "timewarp_video", exposure: "direct", command: "/timewarp", purpose: "Retime a selected scene" },
  { tool: "sync_video_to_audio", exposure: "direct", command: "/sync-audio", purpose: "Retime video to audio anchors" },
  { tool: "transcribe", exposure: "direct", command: "/transcribe", purpose: "Transcribe an asset" },
  { tool: "read_transcript", exposure: "direct", command: "/transcript", purpose: "Read an asset transcript" },
  { tool: "analyze_video", exposure: "internal", purpose: "Describe a video from sampled frames and its transcript" },
  { tool: "translate_subtitles", exposure: "direct", command: "/translate-subs", purpose: "Translate timed subtitles" },
  { tool: "clean_video_audio", exposure: "direct", command: "/clean-audio", purpose: "Clean a video soundtrack" },
  { tool: "isolate_vocals", exposure: "direct", command: "/vocals", purpose: "Isolate vocals" },
  { tool: "render_video", exposure: "direct", command: "/render-video", purpose: "Render a video asset" },
  { tool: "render_timeline", exposure: "direct", command: "/final", purpose: "Render the project timeline" },
  { tool: "get_timeline", exposure: "internal", purpose: "Read raw timeline state" },
  { tool: "set_timeline", exposure: "internal", purpose: "Replace raw timeline state" },
  { tool: "assign_slot", exposure: "direct", command: "/assign", purpose: "Assign an asset to a timeline slot" },
  { tool: "unassign_slot", exposure: "direct", command: "/unassign", purpose: "Clear a timeline slot" },
  { tool: "insert_timeline_slot", exposure: "direct", command: "/insert-slot", purpose: "Insert a timeline slot" },
  { tool: "remove_timeline_slot", exposure: "direct", command: "/remove-slot", purpose: "Remove a timeline slot" },
  { tool: "add_timeline_audio", exposure: "ui", command: "/audio-add", purpose: "Add timeline audio" },
  { tool: "move_timeline_audio", exposure: "ui", command: "/audio-move", purpose: "Move timeline audio" },
  { tool: "remove_timeline_audio", exposure: "ui", command: "/audio-remove", purpose: "Remove timeline audio" },
  { tool: "update_timeline_audio", exposure: "ui", command: "/audio-set", purpose: "Update timeline audio settings" },
  { tool: "get_render_settings", exposure: "ui", command: "/settings", purpose: "Read render settings" },
  { tool: "create_watermark_card", exposure: "composite", command: "/watermark", purpose: "Create and apply a watermark card" },
  { tool: "apply_watermark", exposure: "composite", command: "/watermark", purpose: "Preview and apply optional positioned QR and floating handle watermarks" },
];

function inferredExposure(command: Command): Exclude<CommandExposure, "internal"> {
  if (command.exposure) return command.exposure;
  if (command.mcpTool) return "direct";
  return "ui";
}

export function canonicalizeCommands(commands: readonly Command[]): Command[] {
  const names = new Set<string>();
  const canonicalCommands: Command[] = [];
  for (const command of commands) {
    const aliases = command.aliases ?? [];
    const canonical: Command = {
      ...command,
      canonical: command.command,
      aliases,
      deprecated: false,
      exposure: inferredExposure(command),
    };
    for (const name of [canonical.command, ...aliases]) {
      if (!name.startsWith("/")) throw new Error(`Invalid slash command name: ${name}`);
      if (names.has(name)) throw new Error(`Duplicate slash command name or alias: ${name}`);
      names.add(name);
    }
    canonicalCommands.push(canonical);
  }
  return canonicalCommands;
}

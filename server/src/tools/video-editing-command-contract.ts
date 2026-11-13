import { commandInteraction, type CommandInteraction } from "./command-interaction.js";

type CommandParam = {
  name: string;
  type: "string" | "number" | "boolean" | "string[]";
  required: boolean;
  description: string;
  consumeRest?: boolean;
};

type CommandExposure = "direct" | "ui" | "composite" | "internal";

export const COMMAND_ADAPTER_NAMES = [
  "apply_sfx",
  "change_speed",
  "duplicate",
  "keywords",
  "qr_outro",
  "qrbtf",
  "rewrite_script",
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
  interaction?: CommandInteraction;
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
    command: "/trim",
    description: "Trim video clip",
    example: "/trim @hero-intro 0:05 0:12",
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
    aliases: ["/trim-video", "/clip-trim"],
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
    command: "/overlay",
    description: "Edit a video's on-screen graphics: headline, second line, credit, logo and QR layers with a live preview, then render them in",
    example: "/overlay @vid-yt-clip @img-logo",
    category: "context_menu",
    icon: "Tv",
    size: "default",
    variant: "default",
    chevron: "right",
    params: [
      { name: "asset_id", type: "string", required: true, description: "Video to add graphics to" },
      { name: "image", type: "string", required: false, description: "Image to add as a layer, such as a logo" },
    ],
    uiAction: "open_osg",
    exposure: "ui",
    aliases: ["/osg", "/graphics"],
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
];

export const VIDEO_EDITING_TOOL_CONTRACTS: VideoEditingToolContract[] = [
  { tool: "prepare_cold_open", exposure: "composite", command: "/edit-cold-open", purpose: "Select an AI highlight for review" },
  { tool: "edit_cold_open", exposure: "composite", command: "/edit-cold-open", purpose: "Render a reviewed cold-open copy" },
  { tool: "trim_video", exposure: "direct", command: "/trim", purpose: "Keep a range, remove ranges or shave the ends, in place or into a new cell" },
  { tool: "trim_audio", exposure: "direct", command: "/trim-audio", purpose: "Keep or remove a time range from audio" },
  { tool: "split_video", exposure: "composite", command: "/split", purpose: "Split a video at times, durations or scenes into new cells" },
  { tool: "pad_video", exposure: "direct", command: "/pad", purpose: "Append black frames and silence" },
  { tool: "crop_asset", exposure: "ui", command: "/crop", purpose: "Interactive image or video crop" },
  { tool: "invert_image", exposure: "direct", command: "/invert", purpose: "Invert image colors" },
  { tool: "animate_keywords", exposure: "direct", command: "/keywords", purpose: "Configure transcript-timed keyword graphics" },
  { tool: "caption_video", exposure: "ui", command: "/subs", purpose: "Prepare, edit and render TikTok-style subtitles in the composer" },
  { tool: "video_graphics", exposure: "ui", command: "/overlay", purpose: "Read, save, render and suggest text for a video's on-screen graphics layers" },
  { tool: "detect_scenes", exposure: "direct", command: "/detect-scenes", purpose: "Detect visual scene boundaries" },
  { tool: "suggest_cuts", exposure: "direct", command: "/suggest-cuts", purpose: "Suggest removable video ranges" },
  { tool: "analyze_jokes", exposure: "direct", command: "/analyze-jokes", purpose: "Analyze edit points around jokes" },
  { tool: "suggest_sfx", exposure: "direct", command: "/sfx", purpose: "Suggest sound-effect placements" },
  { tool: "apply_sfx", exposure: "internal", purpose: "Generate and mix sound effects" },
  { tool: "inject_first_frame", exposure: "direct", command: "/replace-first-frame", purpose: "Replace frame zero with an image" },
  { tool: "extract_frame", exposure: "direct", command: "/extract-frame", purpose: "Extract the first, last or a timed video frame" },
  { tool: "extract_notebook_frame", exposure: "internal", purpose: "Extract a frame from a video cell into a new image cell" },
  { tool: "extract_notebook_audio", exposure: "internal", purpose: "Extract audio from a video cell into a new audio cell" },
  { tool: "extract_audio", exposure: "direct", command: "/extract-audio", purpose: "Extract a video soundtrack" },
  { tool: "make_cover_song", exposure: "direct", command: "/make-cover-song", purpose: "Make an exact-duration instrumental cover from video or audio" },
  { tool: "extend_audio_asset", exposure: "direct", command: "/extend-audio", purpose: "Extend an audio asset" },
  { tool: "remove_sound", exposure: "direct", command: "/remove-sound", purpose: "Remove a described sound" },
  { tool: "audio_boost", exposure: "direct", command: "/audio-boost", purpose: "Increase audio volume" },
  { tool: "audio_mix", exposure: "direct", command: "/audio-mix", purpose: "Mix an audio layer into an asset" },
  { tool: "replace_video_audio", exposure: "direct", command: "/replace-audio", purpose: "Replace a video soundtrack" },
  { tool: "splice_video", exposure: "direct", command: "/splice", purpose: "Splice two or more videos" },
  { tool: "preview_splice", exposure: "internal", purpose: "Score splice match frames for the live splice preview" },
  { tool: "smooth_scene_concat", exposure: "internal", purpose: "Join scenes with aligned audio" },
  { tool: "reverse_video", exposure: "direct", command: "/reverse", purpose: "Reverse video playback" },
  { tool: "change_video_speed", exposure: "direct", command: "/speed", purpose: "Change playback speed or duration" },
  { tool: "timewarp_video", exposure: "direct", command: "/timewarp", purpose: "Retime a selected scene" },
  { tool: "sync_video_to_audio", exposure: "direct", command: "/sync-audio", purpose: "Retime video to audio anchors" },
  { tool: "transcribe", exposure: "direct", command: "/transcribe", purpose: "Transcribe an asset" },
  { tool: "read_transcript", exposure: "internal", purpose: "Read an asset transcript" },
  { tool: "analyze_video", exposure: "internal", purpose: "Describe a video from sampled frames and its transcript" },
  { tool: "translate_subtitles", exposure: "direct", command: "/translate-subs", purpose: "Translate timed subtitles" },
  { tool: "clean_video_audio", exposure: "direct", command: "/clean-audio", purpose: "Clean a video soundtrack" },
  { tool: "isolate_vocals", exposure: "direct", command: "/vocals", purpose: "Isolate vocals" },
  { tool: "render_video", exposure: "direct", command: "/render-video", purpose: "Render a video asset" },
  { tool: "get_timeline", exposure: "internal", purpose: "Read raw timeline state" },
  { tool: "set_timeline", exposure: "internal", purpose: "Replace raw timeline state" },
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
      interaction: commandInteraction(command.command, command.uiAction),
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

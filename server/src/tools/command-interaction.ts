export type CommandInteraction = "direct" | "preview" | "fullscreen";

export const FULLSCREEN_COMMANDS: readonly string[] = ["/notebook", "/music-video", "/providers", "/jobs"];

export const PREVIEW_COMMANDS: readonly string[] = [
  "/trim-video", "/trim-audio", "/overlay", "/translate-subs", "/post", "/crop", "/describe", "/suggest-cuts",
  "/analyze-jokes", "/suggest-sfx", "/apply-sfx", "/sound-effects", "/goal", "/run", "/generate-cell", "/rename-all",
  "/edit-cold-open", "/watermark", "/rewrite", "/rewrite-script", "/tldr", "/make-cover-song", "/archive",
  "/extend-audio", "/remove-sound", "/clean-audio", "/vocals", "/transcribe", "/subs", "/settings",
  "/settings-landscape", "/settings-portrait", "/settings-square", "/bg", "/audio-settings", "/speed", "/timewarp",
  "/sync-audio", "/splice", "/scene-concat", "/split", "/skeleton", "/speak", "/say", "/caption", "/duck", "/fit",
  "/gap", "/insert", "/move", "/overwrite", "/clip-audio", "/volume", "/rough-cut", "/export-sequence", "/final",
  "/reframe", "/clip-trim", "/split-clip", "/audio-add", "/audio-move", "/audio-set",
];

export function commandInteraction(command: string, uiAction?: string): CommandInteraction {
  if (FULLSCREEN_COMMANDS.includes(command)) return "fullscreen";
  if (PREVIEW_COMMANDS.includes(command)) return "preview";
  if (uiAction === "switch_book" || command.startsWith("/")) return "direct";
  throw new Error(`Invalid slash command name: ${command}`);
}

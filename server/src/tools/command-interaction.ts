export type CommandInteraction = "direct" | "preview" | "fullscreen";

export const FULLSCREEN_COMMANDS: readonly string[] = ["/notebook", "/music-video", "/providers", "/jobs"];

export const PREVIEW_COMMANDS: readonly string[] = [
  "/trim", "/trim-audio", "/overlay", "/translate-subs", "/post", "/crop", "/describe", "/suggest-cuts",
  "/analyze-jokes", "/sfx", "/goal", "/run", "/rename-all",
  "/edit-cold-open", "/watermark", "/rewrite", "/make-cover-song", "/archive",
  "/extend-audio", "/remove-sound", "/clean-audio", "/vocals", "/transcribe", "/subs", "/settings",
  "/speed", "/timewarp",
  "/sync-audio", "/splice", "/split", "/skeleton", "/speak", "/caption", "/duck", "/fit",
  "/gap", "/insert", "/move", "/overwrite", "/clip-audio", "/rough-cut", "/export",
];

export function commandInteraction(command: string, uiAction?: string): CommandInteraction {
  if (FULLSCREEN_COMMANDS.includes(command)) return "fullscreen";
  if (PREVIEW_COMMANDS.includes(command)) return "preview";
  if (uiAction === "switch_book" || command.startsWith("/")) return "direct";
  throw new Error(`Invalid slash command name: ${command}`);
}

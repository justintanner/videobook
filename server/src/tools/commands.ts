import type { ClipfirstFs } from "clipfirst-fs";
import type { ToolDef } from "./tool-def.js";

interface CommandParam {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description: string;
}

interface McpToolBinding {
  tool: string;
  autoInject?: string[];
}

interface VisibleWhen {
  assetPrefix?: string[];
}

interface Command {
  command: string;
  description: string;
  example?: string;
  category: "action" | "project" | "context_menu";
  icon: string;
  size: "sm" | "default" | "lg";
  variant: "default" | "violet";
  chevron: "right" | "down";
  params: CommandParam[];
  mcpTool?: McpToolBinding;
  uiAction?: string;
  visibleWhen?: VisibleWhen;
}

const HARDCODED_COMMANDS: Command[] = [
  {
    command: "/generate",
    description: "Generate content from prompt",
    example: "/generate video of a dog on a skateboard @bg-neon",
    category: "action",
    icon: "Zap",
    size: "lg",
    variant: "default",
    chevron: "right",
    params: [
      { name: "prompt", type: "string", required: true, description: "The prompt to generate from" },
      { name: "model", type: "string", required: false, description: "Model to use for generation" },
    ],
  },
  {
    command: "/rewrite-prompt",
    description: "Optimize a prompt",
    example: '/rewrite-prompt "make it more cinematic"',
    category: "action",
    icon: "Sparkles",
    size: "sm",
    variant: "default",
    chevron: "right",
    params: [
      { name: "prompt", type: "string", required: true, description: "The prompt to rewrite" },
    ],
    mcpTool: { tool: "rewrite_prompt", autoInject: ["project_slug"] },
    visibleWhen: { assetPrefix: ["vid", "img"] },
  },
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
  },
  {
    command: "/trim-audio",
    description: "Trim audio clip",
    example: "/trim-audio @voiceover-main 0:00 0:30",
    category: "action",
    icon: "Scissors",
    size: "default",
    variant: "default",
    chevron: "right",
    params: [
      { name: "asset_id", type: "string", required: true, description: "Asset to trim" },
      { name: "start", type: "string", required: false, description: "Start timestamp" },
      { name: "end", type: "string", required: false, description: "End timestamp" },
    ],
  },
  {
    command: "/isolate-vocals",
    description: "Isolate vocals from audio",
    example: "/isolate-vocals @voiceover-main",
    category: "action",
    icon: "Mic",
    size: "default",
    variant: "violet",
    chevron: "right",
    params: [
      { name: "asset_id", type: "string", required: true, description: "Asset to isolate vocals from" },
    ],
    mcpTool: { tool: "isolate_vocals", autoInject: ["project_slug"] },
    visibleWhen: { assetPrefix: ["vid", "aud"] },
  },
  {
    command: "/final",
    description: "Finalize and export",
    example: "/final",
    category: "action",
    icon: "Clapperboard",
    size: "default",
    variant: "default",
    chevron: "right",
    params: [],
  },
  {
    command: "/download",
    description: "Download video from URL",
    example: "/download https://youtube.com/watch?v=abc123",
    category: "action",
    icon: "Download",
    size: "lg",
    variant: "default",
    chevron: "right",
    params: [
      { name: "url", type: "string", required: true, description: "Video URL (YouTube, Twitter/X, Instagram, TikTok, etc.)" },
      { name: "start_time", type: "string", required: false, description: "Start time (e.g. '30', '1:30', '2m20s')" },
      { name: "end_time", type: "string", required: false, description: "End time (e.g. '60', '2:00', '3m')" },
      { name: "full", type: "boolean", required: false, description: "Download entire video (no 3-min cap)" },
    ],
    mcpTool: { tool: "download_video_file", autoInject: ["project_slug"] },
  },
  {
    command: "/upload",
    description: "Upload a file",
    example: "/upload",
    category: "action",
    icon: "Upload",
    size: "default",
    variant: "default",
    chevron: "right",
    params: [],
    uiAction: "open_upload",
  },
  {
    command: "/inbox",
    description: "View generations inbox",
    example: "/inbox",
    category: "action",
    icon: "Mailbox",
    size: "default",
    variant: "default",
    chevron: "down",
    params: [],
    uiAction: "open_inbox",
  },
  {
    command: "/copy-name",
    description: "Copy asset name",
    example: "/copy-name @hero-intro",
    category: "context_menu",
    icon: "ClipboardCopy",
    size: "default",
    variant: "default",
    chevron: "right",
    params: [
      { name: "asset_id", type: "string", required: true, description: "Asset whose name to copy" },
    ],
    uiAction: "copy_clipboard",
  },
  {
    command: "/show-folder",
    description: "Show asset folder",
    example: "/show-folder @product-shot",
    category: "context_menu",
    icon: "FolderOpen",
    size: "default",
    variant: "default",
    chevron: "right",
    params: [
      { name: "asset_id", type: "string", required: true, description: "Asset to open folder for" },
    ],
    mcpTool: { tool: "show_folder", autoInject: ["project_slug"] },
  },
  {
    command: "/duplicate",
    description: "Duplicate an asset",
    example: "/duplicate @hero-intro hero-intro-v2",
    category: "context_menu",
    icon: "Copy",
    size: "default",
    variant: "default",
    chevron: "right",
    params: [
      { name: "asset_id", type: "string", required: true, description: "Asset to duplicate" },
      { name: "new_name", type: "string", required: false, description: "Optional name for the copy" },
    ],
    mcpTool: { tool: "duplicate_asset", autoInject: ["project_slug"] },
  },
  {
    command: "/history",
    description: "View asset version history",
    example: "/history @hero-intro",
    category: "context_menu",
    icon: "History",
    size: "default",
    variant: "default",
    chevron: "right",
    params: [
      { name: "asset_id", type: "string", required: true, description: "Asset to view history for" },
    ],
    uiAction: "show_history",
  },
  {
    command: "/open",
    description: "Open asset in viewer",
    example: "/open @hero-intro",
    category: "context_menu",
    icon: "Eye",
    size: "default",
    variant: "default",
    chevron: "right",
    params: [
      { name: "asset_id", type: "string", required: true, description: "Asset to open" },
    ],
    uiAction: "open_asset",
  },
  {
    command: "/delete",
    description: "Delete an asset",
    example: "/delete @outro-clip",
    category: "context_menu",
    icon: "Trash2",
    size: "default",
    variant: "default",
    chevron: "right",
    params: [
      { name: "asset_id", type: "string", required: true, description: "Asset to delete" },
    ],
    mcpTool: { tool: "delete_asset", autoInject: ["project_slug"] },
  },
  {
    command: "/rename",
    description: "Rename an asset",
    example: "/rename @product-shot product-hero",
    category: "context_menu",
    icon: "Pencil",
    size: "default",
    variant: "default",
    chevron: "right",
    params: [
      { name: "asset_id", type: "string", required: true, description: "Asset to rename" },
      { name: "new_name", type: "string", required: true, description: "New name for the asset" },
    ],
    mcpTool: { tool: "rename_asset", autoInject: ["project_slug"] },
  },
];

export function commandsDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "commands",
    description: "List all available slash commands (hardcoded actions and dynamic project commands)",
    schema: {},
    handler: async () => {
      const projects = await fs.listProjects({ sort: "newest" });
      const projectCommands: Command[] = projects.map((p) => ({
        command: `/${p.slug}`,
        description: `Switch to project ${p.slug}`,
        category: "project" as const,
        icon: "FolderOpen",
        size: "default" as const,
        variant: "default" as const,
        chevron: "down" as const,
        params: [],
      }));
      const allCommands = [...HARDCODED_COMMANDS, ...projectCommands];
      return {
        content: [{ type: "text" as const, text: JSON.stringify(allCommands) }],
      };
    },
  };
}

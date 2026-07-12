import type { ToolResult } from "./tool-def.js";

const EXCLUDED_TOOLS = new Set([
  "api_status",
  "asset_history",
  "asset_manifest",
  "chat",
  "commands",
  "copy_file_to_clipboard",
  "detect_scenes",
  "estimate_cost",
  "export_to_downloads",
  "generation_payload",
  "get_default_project",
  "get_timeline",
  "list_assets",
  "list_chat_history",
  "list_projects",
  "list_prompt_history",
  "mark_asset_seen",
  "preview_image",
  "preview_video",
  "project_activity",
  "project_history",
  "push_chat_history",
  "read_asset_metadata",
  "read_file_at_commit",
  "read_notebook",
  "record_prompt",
  "render_settings",
  "show_folder",
  "slash_commands",
  "sleep",
  "slugs",
  "switch_project",
  "sync",
  "translate_payload",
  "x_connect_status",
  "x_connect_start",
]);

export function actionNameForTool(toolName: string): string {
  return `tool-${toolName.replace(/_/g, "-")}`;
}

export function isLoggedToolActivity(
  toolName: string,
  args: Record<string, unknown>,
  result: ToolResult,
): boolean {
  return typeof args.project_slug === "string" && !result.isError && !EXCLUDED_TOOLS.has(toolName);
}

export function isExcludedAction(action: string): boolean {
  if (!action.startsWith("tool-")) return false;
  const toolName = action.slice(5).replace(/-/g, "_");
  return EXCLUDED_TOOLS.has(toolName);
}

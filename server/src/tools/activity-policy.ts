import type { ToolResult } from "./tool-def.js";

const EXCLUDED_TOOLS = new Set([
  "check_kimi_coding_api",
  "asset_history",
  "asset_manifest",
  "chat",
  "commands",
  "copy_file_to_clipboard",
  "detect_scenes",
  "estimate_cost",
  "export_to_downloads",
  "export_transcript_srt",
  "inspect_generation_request",
  "ensure_default_project",
  "get_timeline",
  "list_assets",
  "list_projects",
  "list_prompt_history",
  "mark_asset_seen",
  "prepare_image_generation",
  "prepare_video_generation",
  "project_activity",
  "project_history",
  "read_asset_metadata",
  "read_file_at_commit",
  "read_notebook",
  "record_book_action",
  "record_book_layout",
  "record_prompt",
  "get_render_settings",
  "get_book_action",
  "get_character",
  "get_notebook",
  "get_prompt",
  "get_scene",
  "get_project_book",
  "show_folder",
  "list_jobs",
  "list_notebooks",
  "list_entities",
  "slash_commands",
  "storage_status",
  "revision_history",
  "wait_for_asset_ready",
  "switch_project",
  "reconcile_project_work",
  "x_connect_status",
  "x_connect_start",
]);

const READ_ONLY_PREFIXES = [
  "check_",
  "detect_",
  "estimate_",
  "get_",
  "inspect_",
  "list_",
  "prepare_",
  "read_",
  "search_",
  "show_",
  "wait_",
];

export function actionNameForTool(toolName: string): string {
  return `tool-${toolName.replace(/_/g, "-")}`;
}

export function isLoggedToolActivity(
  toolName: string,
  args: Record<string, unknown>,
  result: ToolResult,
): boolean {
  return isBookToolActivity(toolName, args) && !result.isError;
}

function isBookToolActivity(
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  return typeof args.book_id === "string" &&
    !EXCLUDED_TOOLS.has(toolName) &&
    !READ_ONLY_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

export function isExcludedAction(action: string): boolean {
  if (!action.startsWith("tool-")) return false;
  const toolName = action.slice(5).replace(/-/g, "_");
  return EXCLUDED_TOOLS.has(toolName) ||
    READ_ONLY_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

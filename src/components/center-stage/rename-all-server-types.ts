/** Shared row shape returned by the rename_all MCP tool. Mirrors the server's
 *  RenameRow so the UI can consume it without importing server code. */
export type RenameStatus = "renamable" | "skipped" | "unchanged" | "conflict";

export interface RenameRow {
  asset_id: string;
  type: "video" | "image";
  current_slug: string;
  current_name: string;
  suggested_name: string;
  target_asset_id: string;
  status: RenameStatus;
  reason?: string;
}

export interface RenameAllDryRunResponse {
  dry_run: true;
  rows: RenameRow[];
  model?: string;
  note?: string;
}

export interface RenameAllApplyResult {
  dry_run: false;
  applied: Array<{
    asset_id: string;
    target_asset_id: string;
    new_asset_id: string;
    renamed: boolean;
    error?: string;
  }>;
  references_updated: boolean;
}

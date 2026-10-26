/**
 * Tools that spend provider money: generation, analysis, transcription,
 * tagging, and the notebook run entry points that dispatch paid cells.
 */
export const BILLABLE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "prepare_cold_open", "analyze_video", "analyze_jokes", "suggest_cuts", "suggest_sfx", "apply_sfx",
  "transcribe", "translate_subtitles", "isolate_vocals", "clean_video_audio",
  "make_cover_song", "extend_audio_asset", "rewrite_prompt", "rewrite_script",
  "describe_image", "analyze_image_subjects", "edit_image_subjects", "rename_all",
  "retag_asset", "verify_x_mentions",
  "backfill_asset_tags", "retry_generation", "retry_job",
  "run_notebook", "run_notebook_cell", "enqueue_notebook_run", "continue_notebook_generation",
  "generate_image", "generate_video", "generate_audio",
]);

/**
 * One answer to "does running this cost the user money", shared by the workspace
 * action catalog's confirmation policy and the chain's per-step approval gate so
 * the two can never drift apart.
 */
export const BILLABLE_TOOL_OPERATIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  caption_video: new Set(["prepare"]),
};

export function toolSpendsMoney(name: string, args?: Record<string, unknown>): boolean {
  if (BILLABLE_TOOL_NAMES.has(name)) return true;
  const operations = BILLABLE_TOOL_OPERATIONS[name];
  if (!operations) return false;
  if (!args) return true;
  return operations.has(typeof args.op === "string" ? args.op : "get");
}

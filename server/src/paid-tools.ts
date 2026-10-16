import { GENERATION_ACTIONS } from "./generation-registry.js";

/**
 * Tools that spend provider money without being registered generation actions:
 * analysis, transcription, tagging, and the notebook run entry points that
 * dispatch paid cells on our behalf.
 */
const BILLABLE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "prepare_cold_open", "analyze_video", "analyze_jokes", "suggest_cuts", "suggest_sfx", "apply_sfx",
  "transcribe", "translate_subtitles", "isolate_vocals", "clean_video_audio",
  "make_cover_song", "extend_audio_asset", "rewrite_prompt", "rewrite_script",
  "describe_image", "analyze_image_subjects", "edit_image_subjects", "rename_all",
  "retag_asset", "verify_x_mentions",
  "create_google_flow_voice", "backfill_asset_tags", "retry_generation", "retry_job",
  "run_notebook", "run_notebook_cell", "enqueue_notebook_run", "continue_notebook_generation",
  "generate_image", "generate_video", "generate_audio",
]);

const generationToolNames: ReadonlySet<string> = new Set(
  GENERATION_ACTIONS.map((action) => action.canonical_name),
);

/**
 * One answer to "does running this cost the user money", shared by the workspace
 * action catalog's confirmation policy and the chain's per-step approval gate so
 * the two can never drift apart. Registered tools always carry their canonical
 * name, so legacy aliases are deliberately not consulted here.
 */
export function toolSpendsMoney(name: string): boolean {
  return generationToolNames.has(name) || BILLABLE_TOOL_NAMES.has(name);
}

export const UI_ACTION_IDS = [
  "open_upload", "open_inbox", "open_status", "copy_clipboard", "show_history",
  "open_asset", "open_crop", "open_osg", "switch_book", "viewer_set_original",
  "viewer_set_landscape", "viewer_set_portrait", "viewer_toggle_info",
  "viewer_focus_file", "viewer_show_settings", "settings_landscape",
  "settings_portrait", "settings_square", "settings_subs", "settings_audio",
  "settings_bg", "settings_osg", "open_watermark", "open_post_composer",
  "open_notebook", "open_music_video", "open_rename_all", "open_projects",
  "close_viewer", "sidebar_collapse", "sidebar_expand", "sidebar_sort",
  "open_provider_keys", "open_archive", "timeline_audio_add", "timeline_audio_move",
  "timeline_audio_remove", "timeline_audio_update", "extract_skeleton",
  "rewind_activity", "open_slot_player", "open_gf_characters", "open_diagnostics",
  "open_entities", "open_jobs", "open_revisions", "run_notebook", "save_notebook",
  "speak_preview", "x_connect", "open_actions",
] as const;

export type UiActionId = typeof UI_ACTION_IDS[number];

export const APPLICATION_COMMAND_IDS = [
  "/arrange-videos-column", "/arrange-videos-row", "/group-images", "/split", "/split-clip",
  "/caption", "/duck", "/fit", "/gap", "/generate-cell", "/insert", "/move",
  "/overwrite", "/reframe", "/rough-cut", "/sound-effects", "/track-add",
  "/track-remove", "/volume", "/clip-delete", "/clip-reverse", "/clip-trim", "/export-sequence",
] as const;

export type ApplicationCommandId = typeof APPLICATION_COMMAND_IDS[number];

export type ActionGroup =
  | "Workspace"
  | "Notebook"
  | "Media"
  | "Video"
  | "Audio"
  | "Images"
  | "Generation"
  | "Sequence"
  | "Search"
  | "Tags"
  | "Entities"
  | "History"
  | "Recovery"
  | "Publishing"
  | "Providers";

export type ActionSurface =
  | "slash"
  | "launcher"
  | "button"
  | "cell-menu"
  | "library-menu"
  | "selection-menu"
  | "inspector"
  | "fullscreen";

type ActionFocusPolicy = "composer" | "opener" | "dialog" | "preserve";

export type ActionInputSchema = {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, ActionInputSchema>;
  required?: string[];
  items?: ActionInputSchema;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  format?: string;
  anyOf?: ActionInputSchema[];
  oneOf?: ActionInputSchema[];
  allOf?: ActionInputSchema[];
  additionalProperties?: boolean | ActionInputSchema;
};

export type ActionTarget = {
  kind: "none" | "asset" | "cell" | "clip" | "track" | "notebook";
  argument?: string;
  multiple?: boolean;
  mediaKinds?: Array<"video" | "audio" | "image" | "script" | "final" | "character">;
};

export type WorkspaceAction = {
  id: string;
  title: string;
  description: string;
  group: ActionGroup;
  command: string;
  aliases: string[];
  keywords: string[];
  scope: "global" | "book" | "notebook" | "sequence";
  target: ActionTarget;
  handler:
    | { kind: "tool"; tool: string }
    | { kind: "ui"; action: UiActionId }
    | { kind: "command"; command: ApplicationCommandId };
  inputSchema: ActionInputSchema;
  initialArgs?: Record<string, unknown>;
  generation?: { provider: string; operation: string; mediaType: string };
  surfaces: ActionSurface[];
  focus: ActionFocusPolicy;
  confirmation: "none" | "destructive" | "generation" | "external";
};

type ActionToolCoverage = {
  tool: string;
  actionId: string;
  exposure: "action" | "workflow";
  reason: string;
};

export type WorkspaceActionCatalog = {
  actions: WorkspaceAction[];
  tools: ActionToolCoverage[];
};

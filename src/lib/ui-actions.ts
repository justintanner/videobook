export interface UiActionCallbacks {
  open_upload: () => void;
  open_inbox: () => void;
  open_status: () => void;
  open_gen: (type: string, prompt: string) => void;
  open_gen_video: (prompt: string) => void;
  open_gen_image: (prompt: string) => void;
  copy_clipboard: (raw: string) => void;
  show_history: (assetId: string) => void;
  open_asset: (assetId: string) => void;
  open_trim: (assetId: string) => void;
  open_crop: (assetId: string, ratio?: string) => void;
  open_osg: (assetId: string, imageId?: string) => void;
  switch_project: (slug: string) => void;
  viewer_set_original: () => void;
  viewer_set_landscape: () => void;
  viewer_set_portrait: () => void;
  viewer_toggle_info: () => void;
  viewer_focus_file: (position: number) => void;
  viewer_show_settings: () => void;
  settings_landscape: () => void;
  settings_portrait: () => void;
  settings_square: () => void;
  settings_subs: (field: string, value: string) => void;
  settings_audio: (field: string, value: string) => void;
  settings_bg: (mode: string) => void;
  settings_osg: (field: string, value: string) => void;
  settings_watermark: (handle: string, url: string, position: string, scale: string) => void;
  gen_prompt: (text: string) => void;
  gen_model: (key: string) => void;
  gen_aspect: (ratio: string) => void;
  gen_duration: (value: string) => void;
  gen_mode: (value: string) => void;
  gen_style: (value: string) => void;
  gen_neg: (text: string) => void;
  gen_images: (slugs: string) => void;
  gen_elements: (index: string, field: string, value: string) => void;
  open_character_dialog: (initialSlug: string) => void;
  open_post_composer: (assetSlug: string, text: string) => void;
  open_plan: () => void;
  open_templates: () => void;
  open_projects: () => void;
  create_project: (slug: string) => void;
  rename_project: (newSlug: string) => void;
  delete_project: (slug: string) => void;
  close_viewer: () => void;
  sidebar_collapse: (side: string) => void;
  sidebar_expand: (side: string) => void;
  sidebar_sort: (order: string) => void;
  open_provider_keys: () => void;
  open_archive: (query: string) => void;
  timeline_audio_add: (assetId: string, startSec: string, durationSec: string) => void;
  timeline_audio_move: (audioRef: string, startSec: string) => void;
  timeline_audio_remove: (audioRef: string) => void;
  timeline_audio_update: (audioRef: string, field: string, value: string) => void;
  extract_skeleton: (assetId: string) => void;
  rewind_activity: (commitHash: string) => void;
  show_voices: () => void;
  x_connect: () => void;
  open_slot_player: (slot: string) => void;
}

export type UiActionMap = Partial<UiActionCallbacks>;

export function executeUiAction(
  action: string,
  map: UiActionMap,
  ctx: { raw: string; args: Record<string, string> },
): boolean {
  const fn = map[action as keyof UiActionCallbacks];
  if (!fn) return false;

  switch (action) {
    case 'copy_clipboard':
      (fn as UiActionCallbacks['copy_clipboard'])(ctx.raw);
      break;
    case 'show_history':
      (fn as UiActionCallbacks['show_history'])(ctx.args.asset_id ?? ctx.raw);
      break;
    case 'open_asset':
      (fn as UiActionCallbacks['open_asset'])(ctx.args.asset_id ?? ctx.raw);
      break;
    case 'open_trim':
      (fn as UiActionCallbacks['open_trim'])(ctx.args.asset_id ?? ctx.raw);
      break;
    case 'open_crop':
      (fn as UiActionCallbacks['open_crop'])(ctx.args.asset_id ?? ctx.raw, ctx.args.ratio);
      break;
    case 'open_osg':
      (fn as UiActionCallbacks['open_osg'])(ctx.args.asset_id ?? ctx.raw, ctx.args.image);
      break;
    case 'open_gen':
      (fn as UiActionCallbacks['open_gen'])(ctx.args.type ?? '', ctx.args.prompt ?? ctx.raw);
      break;
    case 'open_gen_video':
      (fn as UiActionCallbacks['open_gen_video'])(ctx.raw || ctx.args.prompt || '');
      break;
    case 'open_gen_image':
      (fn as UiActionCallbacks['open_gen_image'])(ctx.raw || ctx.args.prompt || '');
      break;
    case 'switch_project':
      // The command is /{slug}, so extract slug from the command itself
      (fn as UiActionCallbacks['switch_project'])(ctx.raw || ctx.args.slug || '');
      break;
    case 'viewer_focus_file':
      (fn as UiActionCallbacks['viewer_focus_file'])(parseInt(ctx.args.position, 10) || 1);
      break;
    case 'settings_subs':
      (fn as UiActionCallbacks['settings_subs'])(ctx.args.field ?? '', ctx.args.value ?? '');
      break;
    case 'settings_audio':
      (fn as UiActionCallbacks['settings_audio'])(ctx.args.field ?? '', ctx.args.value ?? '');
      break;
    case 'settings_bg':
      (fn as UiActionCallbacks['settings_bg'])(ctx.args.mode ?? '');
      break;
    case 'settings_osg':
      (fn as UiActionCallbacks['settings_osg'])(ctx.args.field ?? '', ctx.args.value ?? '');
      break;
    case 'settings_watermark':
      (fn as UiActionCallbacks['settings_watermark'])(
        ctx.args.handle ?? ctx.raw,
        ctx.args.url ?? '',
        ctx.args.position ?? '',
        ctx.args.scale ?? '',
      );
      break;
    case 'gen_prompt':
      (fn as UiActionCallbacks['gen_prompt'])(ctx.args.text ?? ctx.raw);
      break;
    case 'gen_model':
      (fn as UiActionCallbacks['gen_model'])(ctx.args.key ?? ctx.raw);
      break;
    case 'gen_aspect':
      (fn as UiActionCallbacks['gen_aspect'])(ctx.args.ratio ?? ctx.raw);
      break;
    case 'gen_duration':
      (fn as UiActionCallbacks['gen_duration'])(ctx.args.value ?? ctx.raw);
      break;
    case 'gen_mode':
      (fn as UiActionCallbacks['gen_mode'])(ctx.args.value ?? ctx.raw);
      break;
    case 'gen_style':
      (fn as UiActionCallbacks['gen_style'])(ctx.args.value ?? ctx.raw);
      break;
    case 'gen_neg':
      (fn as UiActionCallbacks['gen_neg'])(ctx.args.text ?? ctx.raw);
      break;
    case 'gen_images':
      (fn as UiActionCallbacks['gen_images'])(ctx.args.slugs ?? ctx.raw);
      break;
    case 'gen_elements':
      (fn as UiActionCallbacks['gen_elements'])(ctx.args.index ?? '', ctx.args.field ?? '', ctx.args.value ?? ctx.raw);
      break;
    case 'open_character_dialog':
      (fn as UiActionCallbacks['open_character_dialog'])(ctx.raw || ctx.args.model_slug || '');
      break;
    case 'open_post_composer':
      (fn as UiActionCallbacks['open_post_composer'])(ctx.args.asset_slug ?? '', ctx.args.text ?? '');
      break;
    case 'create_project':
      (fn as UiActionCallbacks['create_project'])(ctx.args.project_slug ?? ctx.raw);
      break;
    case 'rename_project':
      (fn as UiActionCallbacks['rename_project'])(ctx.args.new_slug ?? ctx.raw);
      break;
    case 'delete_project':
      (fn as UiActionCallbacks['delete_project'])(ctx.args.project_slug ?? '');
      break;
    case 'sidebar_collapse':
    case 'sidebar_expand':
      (fn as UiActionCallbacks['sidebar_collapse'])(ctx.args.side ?? '');
      break;
    case 'sidebar_sort':
      (fn as UiActionCallbacks['sidebar_sort'])(ctx.args.order ?? '');
      break;
    case 'open_archive':
      (fn as UiActionCallbacks['open_archive'])(ctx.args.query ?? ctx.raw);
      break;
    case 'timeline_audio_add':
      (fn as UiActionCallbacks['timeline_audio_add'])(ctx.args.asset_id ?? '', ctx.args.start ?? '', ctx.args.duration ?? '');
      break;
    case 'timeline_audio_move':
      (fn as UiActionCallbacks['timeline_audio_move'])(ctx.args.audio_ref ?? '', ctx.args.start ?? '');
      break;
    case 'timeline_audio_remove':
      (fn as UiActionCallbacks['timeline_audio_remove'])(ctx.args.audio_ref ?? ctx.raw);
      break;
    case 'timeline_audio_update':
      (fn as UiActionCallbacks['timeline_audio_update'])(ctx.args.audio_ref ?? '', ctx.args.field ?? '', ctx.args.value ?? '');
      break;
    case 'extract_skeleton':
      (fn as UiActionCallbacks['extract_skeleton'])(ctx.args.asset_id ?? ctx.raw);
      break;
    case 'rewind_activity':
      (fn as UiActionCallbacks['rewind_activity'])(ctx.args.commit_hash ?? ctx.raw);
      break;
    case 'open_slot_player':
      (fn as UiActionCallbacks['open_slot_player'])(ctx.args.slot ?? ctx.raw);
      break;
    default:
      // No-arg actions: open_upload, open_inbox, viewer_set_*, viewer_toggle_info,
      // open_templates, open_projects, close_viewer, open_provider_keys, show_voices, x_connect
      (fn as () => void)();
      break;
  }

  return true;
}

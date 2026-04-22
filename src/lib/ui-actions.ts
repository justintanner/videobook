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
  gen_prompt: (text: string) => void;
  gen_model: (key: string) => void;
  gen_aspect: (ratio: string) => void;
  gen_duration: (value: string) => void;
  gen_mode: (value: string) => void;
  gen_style: (value: string) => void;
  gen_neg: (text: string) => void;
  gen_images: (slugs: string) => void;
  gen_elements: (index: string, field: string, value: string) => void;
  open_poses_dialog: (initialSlug: string) => void;
  open_outfit_dialog: (initialSlug: string) => void;
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
    case 'open_poses_dialog':
      (fn as UiActionCallbacks['open_poses_dialog'])(ctx.raw || ctx.args.source_slug || '');
      break;
    case 'open_outfit_dialog':
      (fn as UiActionCallbacks['open_outfit_dialog'])(ctx.raw || ctx.args.model_slug || '');
      break;
    default:
      // No-arg actions: open_upload, open_inbox, viewer_set_*, viewer_toggle_info
      (fn as () => void)();
      break;
  }

  return true;
}

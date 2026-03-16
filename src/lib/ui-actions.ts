export interface UiActionCallbacks {
  open_upload: () => void;
  open_inbox: () => void;
  copy_clipboard: (raw: string) => void;
  show_history: (assetId: string) => void;
  open_asset: (assetId: string) => void;
  switch_project: (slug: string) => void;
  viewer_set_original: () => void;
  viewer_set_landscape: () => void;
  viewer_set_portrait: () => void;
  viewer_toggle_info: () => void;
  viewer_focus_file: (position: number) => void;
  viewer_show_settings: () => void;
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
    case 'switch_project':
      // The command is /{slug}, so extract slug from the command itself
      (fn as UiActionCallbacks['switch_project'])(ctx.raw || ctx.args.slug || '');
      break;
    case 'viewer_focus_file':
      (fn as UiActionCallbacks['viewer_focus_file'])(parseInt(ctx.args.position, 10) || 1);
      break;
    default:
      // No-arg actions: open_upload, open_inbox, viewer_set_*, viewer_toggle_info
      (fn as () => void)();
      break;
  }

  return true;
}

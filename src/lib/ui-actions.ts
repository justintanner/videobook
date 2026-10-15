type UiActionCallbacks = {
  open_upload: () => void
  open_inbox: () => void
  open_status: () => void
  copy_clipboard: (raw: string) => void
  show_history: (assetId: string) => void
  open_asset: (assetId: string) => void
  open_crop: (assetId: string, ratio?: string) => void
  open_osg: (assetId: string, imageId?: string) => void
  switch_book: (name: string) => void
  viewer_set_original: () => void
  viewer_set_landscape: () => void
  viewer_set_portrait: () => void
  viewer_toggle_info: () => void
  viewer_focus_file: (position: number) => void
  viewer_show_settings: () => void
  settings_landscape: () => void
  settings_portrait: () => void
  settings_square: () => void
  settings_subs: (field: string, value: string) => void
  settings_audio: (field: string, value: string) => void
  settings_bg: (mode: string) => void
  settings_osg: (field: string, value: string) => void
  open_cold_open: (assetId: string) => void
  open_post_dropbox: (postRef: string) => void
  open_watermark: (assetId: string) => void
  open_post_composer: (assetId: string, text: string) => void
  open_notebook: (name?: string) => void
  open_rename_all: () => void
  open_projects: () => void
  close_viewer: () => void
  sidebar_collapse: (side: string) => void
  sidebar_expand: (side: string) => void
  sidebar_sort: (order: string) => void
  open_provider_keys: () => void
  open_archive: (query: string) => void
  timeline_audio_add: (assetId: string, startSec: string, durationSec: string) => void
  timeline_audio_move: (audioRef: string, startSec: string) => void
  timeline_audio_remove: (audioRef: string) => void
  timeline_audio_update: (audioRef: string, field: string, value: string) => void
  extract_skeleton: (assetId: string) => void
  rewind_activity: (commitHash: string) => void
  open_slot_player: (slot: string) => void
  open_gf_characters: () => void
  open_diagnostics: () => void
  open_entities: () => void
  open_jobs: () => void
  open_revisions: () => void
  run_notebook: () => void
  save_notebook: () => void
  speak_preview: (text: string) => void
  x_connect: () => void
}

type UiActionMap = Partial<UiActionCallbacks>

type UiActionContext = {
  raw: string
  args: Record<string, string | undefined>
}

export function executeUiAction(
  action: string,
  map: UiActionMap,
  context: UiActionContext,
): boolean {
  const callback = map[action as keyof UiActionCallbacks]
  if (!callback) return false

  const { args, raw } = context
  switch (action) {
    case 'copy_clipboard':
      (callback as UiActionCallbacks['copy_clipboard'])(raw)
      break
    case 'show_history':
      (callback as UiActionCallbacks['show_history'])(args.asset_id ?? raw)
      break
    case 'open_asset':
      (callback as UiActionCallbacks['open_asset'])(args.asset_id ?? raw)
      break
    case 'open_crop':
      (callback as UiActionCallbacks['open_crop'])(args.asset_id ?? raw, args.ratio)
      break
    case 'open_osg':
      (callback as UiActionCallbacks['open_osg'])(args.asset_id ?? raw, args.image)
      break
    case 'switch_book':
      (callback as UiActionCallbacks['switch_book'])(args.book_id ?? args.name ?? raw)
      break
    case 'viewer_focus_file':
      (callback as UiActionCallbacks['viewer_focus_file'])(Number.parseInt(args.position ?? '', 10) || 1)
      break
    case 'settings_subs':
      (callback as UiActionCallbacks['settings_subs'])(args.field ?? '', args.value ?? '')
      break
    case 'settings_audio':
      (callback as UiActionCallbacks['settings_audio'])(args.field ?? '', args.value ?? '')
      break
    case 'settings_bg':
      (callback as UiActionCallbacks['settings_bg'])(args.mode ?? '')
      break
    case 'settings_osg':
      (callback as UiActionCallbacks['settings_osg'])(args.field ?? '', args.value ?? '')
      break
    case 'open_cold_open':
      (callback as UiActionCallbacks['open_cold_open'])(args.asset_ref ?? raw)
      break
    case 'open_post_dropbox':
      (callback as UiActionCallbacks['open_post_dropbox'])(args.post_ref ?? raw)
      break
    case 'open_watermark':
      (callback as UiActionCallbacks['open_watermark'])(args.asset_ref ?? raw)
      break
    case 'open_post_composer':
      (callback as UiActionCallbacks['open_post_composer'])(args.asset_ref ?? '', args.text ?? '')
      break
    case 'open_notebook': {
      const name = (args.name ?? raw).trim()
      const openNotebook = callback as UiActionCallbacks['open_notebook']
      openNotebook(name || undefined)
      break
    }
    case 'sidebar_collapse':
      (callback as UiActionCallbacks['sidebar_collapse'])(args.side ?? '')
      break
    case 'sidebar_expand':
      (callback as UiActionCallbacks['sidebar_expand'])(args.side ?? '')
      break
    case 'sidebar_sort':
      (callback as UiActionCallbacks['sidebar_sort'])(args.order ?? '')
      break
    case 'open_archive':
      (callback as UiActionCallbacks['open_archive'])(args.query ?? raw)
      break
    case 'timeline_audio_add':
      (callback as UiActionCallbacks['timeline_audio_add'])(args.asset_id ?? '', args.start ?? '', args.duration ?? '')
      break
    case 'timeline_audio_move':
      (callback as UiActionCallbacks['timeline_audio_move'])(args.audio_ref ?? '', args.start ?? '')
      break
    case 'timeline_audio_remove':
      (callback as UiActionCallbacks['timeline_audio_remove'])(args.audio_ref ?? raw)
      break
    case 'timeline_audio_update':
      (callback as UiActionCallbacks['timeline_audio_update'])(args.audio_ref ?? '', args.field ?? '', args.value ?? '')
      break
    case 'extract_skeleton':
      (callback as UiActionCallbacks['extract_skeleton'])(args.asset_id ?? raw)
      break
    case 'rewind_activity':
      (callback as UiActionCallbacks['rewind_activity'])(args.commit_hash ?? raw)
      break
    case 'open_slot_player':
      (callback as UiActionCallbacks['open_slot_player'])(args.slot ?? raw)
      break
    case 'speak_preview':
      (callback as UiActionCallbacks['speak_preview'])(args.text ?? raw)
      break
    default:
      (callback as () => void)()
      break
  }

  return true
}

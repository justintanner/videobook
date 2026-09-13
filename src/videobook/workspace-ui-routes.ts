import type { UiActionId } from '../../server/src/workspace-action-contract.js'

type UiRoute =
  | { kind: 'form'; tool: string }
  | { kind: 'search'; query: string }
  | { kind: 'screen'; screen: 'library' | 'jobs' | 'settings' }
  | { kind: 'special'; action: 'upload' | 'copy' | 'history' | 'open' | 'original' | 'landscape' | 'portrait' | 'close' | 'collapse' | 'expand' | 'save' | 'notebook' | 'play' | 'skeleton' }
  | { kind: 'existing' }

export const WORKSPACE_UI_ROUTES: Readonly<Record<UiActionId, UiRoute>> = {
  open_actions: { kind: 'existing' },
  switch_book: { kind: 'existing' },
  open_projects: { kind: 'existing' },
  open_music_video: { kind: 'existing' },
  open_watermark: { kind: 'existing' },
  speak_preview: { kind: 'existing' },
  x_connect: { kind: 'existing' },
  open_provider_keys: { kind: 'screen', screen: 'settings' },
  open_inbox: { kind: 'screen', screen: 'library' },
  open_jobs: { kind: 'screen', screen: 'jobs' },
  open_status: { kind: 'form', tool: 'list_book_actions' },
  open_revisions: { kind: 'form', tool: 'list_book_actions' },
  open_diagnostics: { kind: 'form', tool: 'doctor' },
  open_entities: { kind: 'search', query: 'Entities' },
  open_gf_characters: { kind: 'search', query: 'google flow character' },
  open_archive: { kind: 'form', tool: 'search_archive' },
  open_rename_all: { kind: 'form', tool: 'rename_all' },
  open_crop: { kind: 'form', tool: 'crop_video' },
  open_osg: { kind: 'form', tool: 'set_video_overlay' },
  settings_osg: { kind: 'form', tool: 'set_video_overlay' },
  settings_audio: { kind: 'form', tool: 'render_video' },
  settings_subs: { kind: 'form', tool: 'render_video' },
  settings_bg: { kind: 'form', tool: 'render_video' },
  viewer_show_settings: { kind: 'form', tool: 'render_video' },
  settings_landscape: { kind: 'form', tool: 'render_video' },
  settings_portrait: { kind: 'form', tool: 'render_video' },
  settings_square: { kind: 'form', tool: 'render_video' },
  viewer_focus_file: { kind: 'form', tool: 'asset_manifest' },
  open_post_composer: { kind: 'form', tool: 'post' },
  timeline_audio_add: { kind: 'form', tool: 'add_timeline_audio' },
  timeline_audio_move: { kind: 'form', tool: 'move_timeline_audio' },
  timeline_audio_remove: { kind: 'form', tool: 'remove_timeline_audio' },
  timeline_audio_update: { kind: 'form', tool: 'update_timeline_audio' },
  rewind_activity: { kind: 'form', tool: 'restore_edit_action' },
  sidebar_sort: { kind: 'form', tool: 'list_assets' },
  run_notebook: { kind: 'form', tool: 'plan_notebook_run' },
  open_upload: { kind: 'special', action: 'upload' },
  copy_clipboard: { kind: 'special', action: 'copy' },
  show_history: { kind: 'special', action: 'history' },
  open_asset: { kind: 'special', action: 'open' },
  viewer_set_original: { kind: 'special', action: 'original' },
  viewer_set_landscape: { kind: 'special', action: 'landscape' },
  viewer_set_portrait: { kind: 'special', action: 'portrait' },
  viewer_toggle_info: { kind: 'form', tool: 'read_asset_metadata' },
  close_viewer: { kind: 'special', action: 'close' },
  sidebar_collapse: { kind: 'special', action: 'collapse' },
  sidebar_expand: { kind: 'special', action: 'expand' },
  save_notebook: { kind: 'special', action: 'save' },
  open_notebook: { kind: 'special', action: 'notebook' },
  open_slot_player: { kind: 'special', action: 'play' },
  extract_skeleton: { kind: 'special', action: 'skeleton' },
}

export function workspaceUiFormValues(action: UiActionId, values: Record<string, unknown>, frameRate: number): Record<string, unknown> {
  const result = { ...values }
  if (action === 'open_osg' && values.image) result.osg_asset_id = values.image
  if (action === 'open_post_composer' && values.asset_ref) result.asset_id = values.asset_ref
  if (action === 'sidebar_sort') result.sort = values.order ?? 'newest'
  if (action === 'viewer_toggle_info') result.name = 'original'
  if (action === 'settings_bg') result.background_mode = values.mode
  if (['settings_landscape', 'settings_portrait', 'settings_square'].includes(action)) result.orientation = action.slice('settings_'.length)
  if (action.startsWith('timeline_audio_')) {
    if (values.audio_ref) result.audio_id = values.audio_ref
    if (action === 'timeline_audio_add' || values.start !== undefined) result.start_frame = Math.round(Number(values.start ?? 0) * frameRate)
    if (values.duration !== undefined) result.duration_frames = Math.round(Number(values.duration) * frameRate)
  }
  if (action === 'rewind_activity' && values.commit_hash) result.target_revision = values.commit_hash
  const field = String(values.field ?? '')
  const aliases: Record<string, string> = {
    'fade-in': 'audio_fade_in', 'fade-out': 'audio_fade_out', volume: 'audio_volume',
    enabled: 'subtitles_enabled', style: 'highlight_style', size: 'font_size', fontSize: 'font_size',
    color: 'text_color', textColor: 'text_color', highlight: 'highlight_color', highlightColor: 'highlight_color',
    stroke: 'stroke_width', strokeWidth: 'stroke_width', strokeColor: 'stroke_color',
    shadow: 'shadow_blur', shadowBlur: 'shadow_blur', shadowOpacity: 'shadow_opacity', language: 'subtitle_language',
  }
  if (action === 'settings_subs' && ['on', 'off'].includes(field)) result.subtitles_enabled = field === 'on'
  if (['settings_audio', 'settings_subs', 'timeline_audio_update'].includes(action) && field && values.value !== undefined) {
    const key = action === 'timeline_audio_update' ? field.replaceAll('-', '_') : aliases[field] ?? field
    const value = String(values.value)
    result[key] = ['on', 'off', 'true', 'false'].includes(value) ? ['on', 'true'].includes(value)
      : value.trim() && Number.isFinite(Number(value)) ? Number(value) : value
  }
  return result
}

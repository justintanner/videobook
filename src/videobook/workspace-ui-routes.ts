import type { UiActionId } from '../../server/src/workspace-action-contract.js'

type UiRoute =
  | { kind: 'form'; tool: string }
  | { kind: 'search'; query: string }
  | { kind: 'screen'; screen: 'jobs' | 'settings' }
  | { kind: 'library' }
  | { kind: 'special'; action: 'upload' | 'copy' | 'history' | 'open' | 'original' | 'landscape' | 'portrait' | 'close' | 'collapse' | 'expand' | 'save' | 'notebook' | 'play' | 'skeleton' }
  | { kind: 'existing' }

export const WORKSPACE_UI_ROUTES: Readonly<Record<UiActionId, UiRoute>> = {
  open_actions: { kind: 'existing' },
  switch_book: { kind: 'existing' },
  open_projects: { kind: 'existing' },
  open_music_video: { kind: 'existing' },
  start_goal: { kind: 'existing' },
  open_cold_open: { kind: 'existing' },
  open_post_dropbox: { kind: 'existing' },
  open_post_icloud: { kind: 'existing' },
  open_watermark: { kind: 'existing' },
  speak_preview: { kind: 'existing' },
  x_connect: { kind: 'existing' },
  open_provider_keys: { kind: 'screen', screen: 'settings' },
  open_inbox: { kind: 'library' },
  open_jobs: { kind: 'screen', screen: 'jobs' },
  open_status: { kind: 'form', tool: 'list_book_actions' },
  open_revisions: { kind: 'form', tool: 'list_book_actions' },
  open_diagnostics: { kind: 'form', tool: 'doctor' },
  open_entities: { kind: 'search', query: 'Entities' },
  open_archive: { kind: 'form', tool: 'search_archive' },
  open_rename_all: { kind: 'form', tool: 'rename_all' },
  open_crop: { kind: 'form', tool: 'crop_asset' },
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
  if (action === 'open_crop' && values.ratio !== undefined && values.ratio !== null && String(values.ratio).trim() !== '') {
    result.ratio = cropRatio(values.ratio)
  }
  if (action === 'sidebar_sort') result.sort = sortOrder(values.order)
  if (action === 'viewer_toggle_info') result.name = 'original'
  if (action === 'settings_bg') {
    const mode = backgroundMode(values.mode)
    if (mode) result.background_mode = mode
  }
  if (['settings_landscape', 'settings_portrait', 'settings_square'].includes(action)) result.orientation = action.slice('settings_'.length)
  if (action.startsWith('timeline_audio_')) {
    if (action === 'timeline_audio_add' || values.start !== undefined) result.start_frame = Math.round(Number(values.start ?? 0) * frameRate)
    if (values.duration !== undefined) result.duration_frames = Math.round(Number(values.duration) * frameRate)
  }
  if (action === 'rewind_activity' && values.commit_hash) result.target_revision = values.commit_hash
  const field = String(values.field ?? '').trim().toLowerCase()
  if (action === 'settings_subs' && ['on', 'off'].includes(field)) result.subtitles_enabled = field === 'on'
  if (['settings_audio', 'settings_subs', 'timeline_audio_update'].includes(action) && field && values.value !== undefined) {
    const key = action === 'timeline_audio_update'
      ? timelineAudioField(field)
      : action === 'settings_audio'
        ? audioSettingsField(field)
        : FIELD_ALIASES[field] ?? field
    const value = String(values.value)
    const numeric = Number(value)
    if (action === 'timeline_audio_update' && !Number.isFinite(numeric)) {
      throw new Error('Usage: /audio-set @clip volume|fade-in|fade-out <value>')
    }
    result[key] = ['on', 'off', 'true', 'false'].includes(value.toLowerCase())
      ? ['on', 'true'].includes(value.toLowerCase())
      : value.trim() && Number.isFinite(numeric) ? numeric : subtitleSetting(field, key, value)
  }
  return result
}

const SORT_ORDERS = ['newest', 'oldest'] as const
const BACKGROUND_MODES = ['blur', 'black'] as const
const FIELD_ALIASES: Record<string, string> = {
  'fade-in': 'audio_fade_in', 'fade-out': 'audio_fade_out', volume: 'audio_volume',
  enabled: 'subtitles_enabled', style: 'highlight_style', size: 'font_size', fontsize: 'font_size',
  color: 'text_color', textcolor: 'text_color', highlight: 'highlight_color', highlightcolor: 'highlight_color',
  stroke: 'stroke_width', strokewidth: 'stroke_width', strokecolor: 'stroke_color',
  shadow: 'shadow_blur', shadowblur: 'shadow_blur', shadowopacity: 'shadow_opacity', language: 'subtitle_language',
}

const SUBTITLE_CHOICES: Record<string, readonly string[]> = {
  position: ['top', 'middle', 'bottom'],
  highlight_style: ['impact', 'highlight'],
  font_size: ['small', 'medium', 'large'],
}
const SUBTITLE_ALIASES: Record<string, Record<string, string>> = {
  position: { mid: 'middle' },
  font_size: { s: 'small', m: 'medium', l: 'large' },
}

export function parseFilePosition(value: unknown): number {
  if (value === undefined || value === null || value === '') return 1
  const position = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isInteger(position) || position < 1) {
    throw new Error('Usage: /files <position>')
  }
  return position
}

export function normalizePanelSide(value: string | null): 'left' | 'right' | 'both' {
  const side = (value ?? 'both').trim().toLowerCase()
  if (side === 'left' || side === 'right' || side === 'both') return side
  throw new Error('Choose left, right or both.')
}

function sortOrder(value: unknown): 'newest' | 'oldest' {
  const order = String(value ?? 'newest').trim().toLowerCase()
  if (order === 'newest' || order === 'oldest') return order
  throw new Error(`Usage: /sort ${SORT_ORDERS.join('|')}`)
}

function backgroundMode(value: unknown): 'blur' | 'black' | null {
  if (value === undefined || value === null || String(value).trim() === '') return null
  const mode = String(value).trim().toLowerCase()
  if (mode === 'blur' || mode === 'black') return mode
  throw new Error(`Usage: /bg ${BACKGROUND_MODES.join('|')}`)
}

function cropRatio(value: unknown): '16:9' | '9:16' | '1:1' {
  const token = String(value).trim().toLowerCase()
  if (token === '16:9' || token === 'landscape') return '16:9'
  if (token === '9:16' || token === 'portrait') return '9:16'
  if (token === '1:1' || token === 'square') return '1:1'
  throw new Error('Usage: /crop @asset [16:9|9:16|1:1]')
}

function timelineAudioField(field: string): string {
  const key = field.replaceAll('-', '_')
  if (key === 'volume' || key === 'fade_in' || key === 'fade_out') return key
  throw new Error('Usage: /audio-set @clip volume|fade-in|fade-out <value>')
}

function audioSettingsField(field: string): string {
  const key = FIELD_ALIASES[field]
  if (key === 'audio_volume' || key === 'audio_fade_in' || key === 'audio_fade_out') return key
  throw new Error('Usage: /audio volume|fade-in|fade-out <value>')
}

function subtitleSetting(field: string, key: string, value: string): string {
  if (key === 'subtitle_language') {
    const language = value.trim().toLowerCase()
    if (/^(original|[a-z]{2})$/u.test(language)) return language
    throw new Error('Usage: /subs language original|en')
  }
  const choices = SUBTITLE_CHOICES[key]
  if (!choices) return value
  const lowered = value.trim().toLowerCase()
  const normalized = SUBTITLE_ALIASES[key]?.[lowered] ?? lowered
  if (choices.includes(normalized)) return normalized
  throw new Error(`Usage: /subs ${field} ${choices.join('|')}`)
}

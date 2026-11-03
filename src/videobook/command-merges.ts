import { adaptCommandArgs, parseCommandArgs, type CommandToolArgs } from '../lib/command-registry'
import type { UiActionId } from '../../server/src/workspace-action-contract'

type Params = Parameters<typeof parseCommandArgs>[1]

export type MergedCommandRoute =
  | { kind: 'tool'; tool: string; args: CommandToolArgs; preview: boolean }
  | { kind: 'sound-effects' }
  | { kind: 'settings'; uiAction: UiActionId; values: Record<string, unknown> }

const APPLY_SFX_PARAMS: Params = [
  { name: 'asset_id', type: 'string', required: true, description: 'Video artifact to modify in place' },
  { name: 'timestamp', type: 'number', required: true, description: 'Seconds into the video where the effect starts' },
  { name: 'type', type: 'string', required: true, description: 'Short effect type such as whoosh, impact, or ding' },
  { name: 'description', type: 'string', required: true, description: 'Description of the sound effect to generate' },
]

const SCENE_CONCAT_PARAMS: Params = [
  { name: 'first_asset_id', type: 'string', required: true, description: 'First video in playback order' },
  { name: 'second_asset_id', type: 'string', required: true, description: 'Second video in playback order' },
  { name: 'transition_seconds', type: 'number', required: false, description: 'Optional fixed crossfade duration' },
]

const EXPORT_TO_PARAMS: Params = [
  { name: 'asset_id', type: 'string', required: true, description: 'Asset to export' },
  { name: 'target_project', type: 'string', required: true, description: 'Target book name' },
  { name: 'new_name', type: 'string', required: false, description: 'Optional name for the exported asset' },
]

const REWRITE_SCRIPT_PARAMS: Params = [
  { name: 'asset_id', type: 'string', required: true, description: 'Script asset to rewrite' },
  { name: 'platform', type: 'string', required: false, description: 'Platform preset: ig | tiktok | youtube' },
  { name: 'custom_prompt', type: 'string', required: false, description: 'Optional transformation instruction' },
]

const ORIENTATIONS = new Set(['landscape', 'portrait', 'square'])
const AUDIO_FIELDS = new Set(['volume', 'fade-in', 'fade-out'])

function splitArgs(rest: string): string[] {
  return rest.trim().split(/\s+/u).filter(Boolean)
}

function headAndTail(rest: string): [string, string] {
  const [head = '', ...tail] = splitArgs(rest)
  return [head, tail.join(' ')]
}

const RETIRED_REWRITES: Readonly<Record<string, (rest: string) => string>> = {
  '/recover': (rest) => `/doctor ${rest} fix`,
  '/clear-failed': () => '/doctor clean',
  '/suggest-sfx': (rest) => `/sfx ${rest}`,
  '/apply-sfx': (rest) => `/sfx ${rest}`,
  '/sound-effects': () => '/sfx',
  '/scene-concat': (rest) => {
    const [first = '', second = '', ...tail] = splitArgs(rest)
    return `/splice ${first} ${second} smooth ${tail.join(' ')}`
  },
  '/export-to': (rest) => {
    const [asset, tail] = headAndTail(rest)
    return `/duplicate ${asset} --project ${tail}`
  },
  '/transcript': (rest) => `/transcribe ${rest}`,
  '/rewrite-script': (rest) => `/rewrite ${rest}`,
  '/tldr': (rest) => {
    const [asset, tail] = headAndTail(rest)
    return `/rewrite ${asset} tldr ${tail}`
  },
  '/settings-landscape': (rest) => `/settings landscape ${rest}`,
  '/settings-portrait': (rest) => `/settings portrait ${rest}`,
  '/settings-square': (rest) => `/settings square ${rest}`,
  '/bg': (rest) => `/settings bg ${rest}`,
  '/audio-settings': (rest) => `/settings ${rest}`,
  '/character-new': (rest) => `/character ${rest}`,
}

export function rewriteRetiredCommand(input: string): string {
  const trimmed = input.trim()
  const [token = '', ...rest] = trimmed.split(/\s+/u)
  const rewrite = RETIRED_REWRITES[token.toLowerCase()]
  return rewrite ? rewrite(rest.join(' ')).trim().replace(/\s+/gu, ' ') : input
}

function toolRoute(tool: string, args: CommandToolArgs, preview: boolean): MergedCommandRoute {
  return { kind: 'tool', tool, args, preview }
}

function characterRoute(parts: readonly string[]): MergedCommandRoute | null {
  if (!parts[0]?.startsWith('@')) return null
  return toolRoute('create_character', { args: parts.map((part) => part.replace(/^@/u, '')) }, false)
}

function sfxRoute(parts: readonly string[]): MergedCommandRoute | null {
  if (parts.length === 0) return { kind: 'sound-effects' }
  if (parts.length === 1) return null
  return toolRoute('apply_sfx', adaptCommandArgs('apply_sfx', parseCommandArgs(parts.join(' '), APPLY_SFX_PARAMS)), true)
}

function spliceRoute(parts: readonly string[]): MergedCommandRoute | null {
  if (parts[2]?.toLowerCase() !== 'smooth') return null
  const rest = [parts[0], parts[1], ...parts.slice(3)].join(' ')
  return toolRoute('smooth_scene_concat', parseCommandArgs(rest, SCENE_CONCAT_PARAMS), true)
}

function duplicateRoute(parts: readonly string[]): MergedCommandRoute | null {
  const index = parts.findIndex((part) => part.toLowerCase() === '--project')
  if (index < 0) return null
  const rest = [...parts.slice(0, index), ...parts.slice(index + 1)].join(' ')
  return toolRoute('export_asset_to_project', parseCommandArgs(rest, EXPORT_TO_PARAMS), false)
}

function rewriteRoute(parts: readonly string[]): MergedCommandRoute | null {
  if (!parts[0]?.startsWith('@')) return null
  const tldr = parts.some((part) => part.toLowerCase() === 'tldr')
  const rest = parts.filter((part) => part.toLowerCase() !== 'tldr').join(' ')
  const args = adaptCommandArgs('rewrite_script', parseCommandArgs(rest, REWRITE_SCRIPT_PARAMS))
  return toolRoute('rewrite_script', { ...args, variant: tldr ? 'tldr' : 'full' }, true)
}

function settingsRoute(parts: readonly string[]): MergedCommandRoute | null {
  const asset = parts.find((part) => part.startsWith('@'))
  const words = parts.filter((part) => !part.startsWith('@')).map((part) => part.toLowerCase())
  const [head, value] = words
  const target = asset ? { asset_id: asset.replace(/^@/u, '') } : {}
  if (head && ORIENTATIONS.has(head)) return { kind: 'settings', uiAction: `settings_${head}` as UiActionId, values: target }
  if (head === 'bg') return { kind: 'settings', uiAction: 'settings_bg', values: { ...target, ...(value ? { mode: value } : {}) } }
  if (head && AUDIO_FIELDS.has(head)) return { kind: 'settings', uiAction: 'settings_audio', values: { ...target, field: head, ...(value ? { value } : {}) } }
  return null
}

const MERGED_ROUTES: Readonly<Record<string, (parts: readonly string[]) => MergedCommandRoute | null>> = {
  '/character': characterRoute,
  '/sfx': sfxRoute,
  '/splice': spliceRoute,
  '/duplicate': duplicateRoute,
  '/rewrite': rewriteRoute,
  '/settings': settingsRoute,
}

export function routeMergedCommand(command: string, parts: readonly string[]): MergedCommandRoute | null {
  return MERGED_ROUTES[command]?.(parts) ?? null
}

export function transcribeRequestsFreshRun(parts: readonly string[]): boolean {
  return parts.some((part) => part.toLowerCase() === 'again')
}

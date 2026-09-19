import type { ChatModelOption } from './chat-models'
import type { VoiceMode } from '../../server/src/voice-contract'

// The composer's lit mode cell opens one menu that holds both engines: the chat
// model that answers, and the speech transport that carries your voice. Keeping
// both groups in the same menu is what lets either one be changed from either
// mode, so the speech provider is still pickable before voice is ever started.

export type EngineMenuChoice =
  | { kind: 'model'; model: string }
  | { kind: 'speech'; mode: VoiceMode }

export interface EngineMenuItem {
  id: string
  /** Position among every item across every group, for roving focus. */
  position: number
  label: string
  /** The raw handle behind the label — a model id, shown small beside it. */
  detail: string | null
  /** One line explaining the option, under the label. */
  note: string | null
  checked: boolean
  choice: EngineMenuChoice
}

export type EngineMenuGroupId = 'model' | 'speech'

export interface EngineMenuGroup {
  id: EngineMenuGroupId
  label: string
  items: readonly EngineMenuItem[]
}

export interface EngineMenuInput {
  chatModels: readonly ChatModelOption[]
  selectedModel: string
  /** False while a context composer or a stalled connection owns the model. */
  modelSelectable: boolean
  /** Absent when this composer has no voice conversation attached. */
  voiceMode: VoiceMode | null
}

const VOICE_MODE_ORDER: readonly VoiceMode[] = ['auto', 'openai', 'xai']

const VOICE_MODE_LABELS: Record<VoiceMode, string> = {
  auto: 'Auto',
  openai: 'OpenAI',
  xai: 'xAI',
}

const VOICE_MODE_NOTES: Record<VoiceMode, string | null> = {
  auto: 'Tries OpenAI, then xAI if it cannot connect',
  openai: null,
  xai: null,
}

export function voiceModeLabel(mode: VoiceMode): string {
  return VOICE_MODE_LABELS[mode]
}

function modelItems(input: EngineMenuInput): readonly EngineMenuItem[] {
  if (!input.modelSelectable) return []
  return input.chatModels.map((model, position) => ({
    id: `model:${model.id}`,
    position,
    label: model.label,
    detail: model.id,
    note: model.description,
    checked: model.id === input.selectedModel,
    choice: { kind: 'model', model: model.id },
  }))
}

function speechItems(input: EngineMenuInput, offset: number): readonly EngineMenuItem[] {
  const selected = input.voiceMode
  if (!selected) return []
  return VOICE_MODE_ORDER.map((mode, position) => ({
    id: `speech:${mode}`,
    position: offset + position,
    label: VOICE_MODE_LABELS[mode],
    detail: null,
    note: VOICE_MODE_NOTES[mode],
    checked: mode === selected,
    choice: { kind: 'speech', mode },
  }))
}

export function composerEngineMenu(input: EngineMenuInput): readonly EngineMenuGroup[] {
  const groups: EngineMenuGroup[] = []
  const models = modelItems(input)
  if (models.length > 0) groups.push({ id: 'model', label: 'Chat model', items: models })
  const speech = speechItems(input, models.length)
  if (speech.length > 0) groups.push({ id: 'speech', label: 'Speech', items: speech })
  return groups
}

export function engineMenuItems(groups: readonly EngineMenuGroup[]): readonly EngineMenuItem[] {
  return groups.flatMap((group) => group.items)
}

/** The item focus lands on when the menu opens: the first checked one. */
export function engineMenuInitialIndex(items: readonly EngineMenuItem[]): number {
  const checked = items.findIndex((item) => item.checked)
  return checked === -1 ? 0 : checked
}

export function engineMenuStep(
  items: readonly EngineMenuItem[],
  index: number,
  key: string,
): number | null {
  if (items.length === 0) return null
  if (key === 'ArrowDown') return (index + 1) % items.length
  if (key === 'ArrowUp') return (index - 1 + items.length) % items.length
  if (key === 'Home') return 0
  if (key === 'End') return items.length - 1
  return null
}

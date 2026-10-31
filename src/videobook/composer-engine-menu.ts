import type { ChatModelOption } from './chat-models'
import type { VoiceMode } from '../../server/src/voice-contract'

// Each half of the composer's right-hand cluster carries its own engine menu:
// the phone's names the speech transport that carries your voice, and the text
// half's names the chat model that answers. The speech menu is there before a
// call is ever placed, so the provider is pickable without starting voice.

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

export interface ChatModelMenuInput {
  chatModels: readonly ChatModelOption[]
  selectedModel: string
  /** False while a context composer or a stalled connection owns the model. */
  modelSelectable: boolean
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

function modelItems(input: ChatModelMenuInput): readonly EngineMenuItem[] {
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

function speechItems(selected: VoiceMode): readonly EngineMenuItem[] {
  return VOICE_MODE_ORDER.map((mode, position) => ({
    id: `speech:${mode}`,
    position,
    label: VOICE_MODE_LABELS[mode],
    detail: null,
    note: VOICE_MODE_NOTES[mode],
    checked: mode === selected,
    choice: { kind: 'speech', mode },
  }))
}

export function chatModelMenu(input: ChatModelMenuInput): readonly EngineMenuGroup[] {
  const models = modelItems(input)
  return models.length > 0 ? [{ id: 'model', label: 'Chat model', items: models }] : []
}

export function speechMenu(voiceMode: VoiceMode): readonly EngineMenuGroup[] {
  return [{ id: 'speech', label: 'Speech', items: speechItems(voiceMode) }]
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

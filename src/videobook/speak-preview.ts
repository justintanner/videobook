import type { SpeakVoice } from './use-elevenlabs-voices'

export const ELEVENLABS_VOICE_STORAGE_KEY = 'videobook.elevenlabs-voice'
export const SPEAK_PREVIEW_PREFILL = '/speak '

export type SpeakExecuteContext = {
  speakVoiceId?: string
}

export type SpeakPreviewAction =
  | { kind: 'prefill'; nextInput: string; message: string }
  | { kind: 'generate'; text: string; voiceId: string }
  | { kind: 'error'; message: string }

export function isSpeakCommandPreview(input: string): boolean {
  return /^\/speak(\s|$)/.test(input)
}

export function speakCommandText(input: string): string {
  const match = input.match(/^\/speak(?:\s+([\s\S]*))?$/)
  return match?.[1]?.trim() ?? ''
}

export function resolveSpeakVoiceId(
  voices: readonly SpeakVoice[],
  preferred: string | null | undefined,
): string {
  if (preferred && voices.some((voice) => voice.voiceId === preferred)) {
    return preferred
  }
  return voices[0]?.voiceId ?? ''
}

export function nextSpeakVoiceId(
  voices: readonly SpeakVoice[],
  currentId: string,
  direction: 1 | -1,
): string {
  if (voices.length === 0) return currentId
  const index = voices.findIndex((voice) => voice.voiceId === currentId)
  const from = index < 0 ? 0 : index
  const next = (from + direction + voices.length) % voices.length
  return voices[next]!.voiceId
}

export function readStoredSpeakVoiceId(): string | null {
  if (typeof window === 'undefined') return null
  return window.localStorage.getItem(ELEVENLABS_VOICE_STORAGE_KEY)
}

export function persistSpeakVoiceId(voiceId: string): void {
  if (typeof window === 'undefined' || !voiceId) return
  window.localStorage.setItem(ELEVENLABS_VOICE_STORAGE_KEY, voiceId)
}

export type SpeakPreviewKeyAction =
  | { type: 'select'; voiceId: string }
  | { type: 'toggle' }
  | { type: 'dismiss' }
  | { type: 'ignore' }

export function handleSpeakPreviewKey(
  event: { key: string; code: string; ctrlKey: boolean },
  voices: readonly SpeakVoice[],
  currentId: string,
): SpeakPreviewKeyAction {
  if (event.key === 'ArrowDown') {
    return { type: 'select', voiceId: nextSpeakVoiceId(voices, currentId, 1) }
  }
  if (event.key === 'ArrowUp') {
    return { type: 'select', voiceId: nextSpeakVoiceId(voices, currentId, -1) }
  }
  if (event.key === 'Tab') {
    return currentId ? { type: 'select', voiceId: currentId } : { type: 'ignore' }
  }
  if (event.ctrlKey && event.code === 'Space') {
    return { type: 'toggle' }
  }
  if (event.key === 'Escape') {
    return { type: 'dismiss' }
  }
  return { type: 'ignore' }
}

export function speakExecuteContext(
  input: string,
  voiceId: string,
): SpeakExecuteContext | undefined {
  if (!isSpeakCommandPreview(input) || !voiceId) return undefined
  return { speakVoiceId: voiceId }
}

export function resolveSpeakPreviewAction(input: {
  command: string
  text: string
  voiceId?: string
  hasNotebook: boolean
}): SpeakPreviewAction {
  if (input.command === '/voices') {
    return {
      kind: 'prefill',
      nextInput: SPEAK_PREVIEW_PREFILL,
      message: 'Choose a voice, then type the speech text.',
    }
  }
  if (!input.hasNotebook) {
    return { kind: 'error', message: 'Open a notebook before speaking.' }
  }
  const text = input.text.trim()
  const voiceId = input.voiceId?.trim() ?? ''
  if (!text) {
    return { kind: 'error', message: 'Type the text to speak after /speak.' }
  }
  if (!voiceId) {
    return { kind: 'error', message: 'Select a voice before speaking.' }
  }
  return { kind: 'generate', text, voiceId }
}

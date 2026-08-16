import { useCallback, useEffect, useState } from 'react'

export interface PreviewAudio {
  play: () => Promise<void>
  pause: () => void
  onended: ((ev: Event) => unknown) | null
}

export type CreatePreviewAudio = (url: string) => PreviewAudio

const defaultCreateAudio: CreatePreviewAudio = (url) => new Audio(url)

export function createVoicePreviewPlayer(
  createAudio: CreatePreviewAudio = defaultCreateAudio,
) {
  let current: PreviewAudio | null = null
  let playingVoiceId: string | null = null
  const listeners = new Set<(voiceId: string | null) => void>()

  const notify = () => {
    for (const listener of listeners) listener(playingVoiceId)
  }

  const stop = () => {
    current?.pause()
    current = null
    playingVoiceId = null
    notify()
  }

  const toggle = (voiceId: string, previewUrl: string) => {
    if (!previewUrl) return
    if (playingVoiceId === voiceId) {
      stop()
      return
    }
    current?.pause()
    const audio = createAudio(previewUrl)
    current = audio
    playingVoiceId = voiceId
    notify()
    void audio.play().catch(() => {
      if (current === audio) stop()
    })
    audio.onended = () => {
      if (current === audio) stop()
    }
  }

  return {
    get playingVoiceId() {
      return playingVoiceId
    },
    toggle,
    stop,
    subscribe(listener: (voiceId: string | null) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      current?.pause()
      current = null
      playingVoiceId = null
      listeners.clear()
    },
  }
}

export type VoicePreviewPlayer = ReturnType<typeof createVoicePreviewPlayer>

export function useVoicePreviewPlayer(
  createAudio: CreatePreviewAudio = defaultCreateAudio,
): {
  playingVoiceId: string | null
  toggle: (voiceId: string, previewUrl: string) => void
  stop: () => void
} {
  const [player] = useState(() => createVoicePreviewPlayer(createAudio))
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null)

  useEffect(() => {
    const unsubscribe = player.subscribe(setPlayingVoiceId)
    return () => {
      unsubscribe()
      player.dispose()
    }
  }, [player])

  const toggle = useCallback((voiceId: string, previewUrl: string) => {
    player.toggle(voiceId, previewUrl)
  }, [player])

  const stop = useCallback(() => {
    player.stop()
  }, [player])

  return { playingVoiceId, toggle, stop }
}

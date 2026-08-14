import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { X } from 'lucide-react'

export interface SpeakVoice {
  voiceId: string
  name: string
  source: 'custom' | 'generic'
  category?: string
  previewUrl?: string
}

export interface SpeakDialogState {
  text: string
  voiceId: string
  voices: SpeakVoice[]
  status: 'live' | 'fallback'
  warning: string | null
  loadingVoices: boolean
  submitting: boolean
  error: string | null
}

function focusableDialogElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hidden)
}

export function SpeakDialog({
  state,
  onText,
  onVoice,
  onSubmit,
  onClose,
}: {
  state: SpeakDialogState
  onText: (value: string) => void
  onVoice: (value: string) => void
  onSubmit: () => void
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLElement | null>(null)
  const previewRef = useRef<HTMLAudioElement | null>(null)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const busy = state.submitting
  const canGenerate = Boolean(state.text.trim() && state.voiceId)

  useEffect(() => {
    return () => {
      previewRef.current?.pause()
      previewRef.current = null
    }
  }, [])

  const stopPreview = () => {
    previewRef.current?.pause()
    previewRef.current = null
    setPlayingId(null)
  }

  const selectVoice = (voiceId: string) => {
    if (playingId && playingId !== voiceId) stopPreview()
    onVoice(voiceId)
  }

  const togglePreview = (voice: SpeakVoice) => {
    if (!voice.previewUrl) return
    if (playingId === voice.voiceId) {
      stopPreview()
      return
    }
    previewRef.current?.pause()
    const audio = new Audio(voice.previewUrl)
    previewRef.current = audio
    setPlayingId(voice.voiceId)
    void audio.play().catch(() => {
      if (previewRef.current === audio) stopPreview()
    })
    audio.onended = () => {
      if (previewRef.current === audio) stopPreview()
    }
  }

  return (
    <div
      className="speak-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !busy) onClose()
      }}
    >
      <section
        ref={dialogRef}
        className="speak-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="speak-title"
        aria-describedby="speak-description"
        onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
          if (event.key === 'Escape' && !busy) {
            event.preventDefault()
            onClose()
            return
          }
          if (event.key !== 'Tab' || !dialogRef.current) return
          const focusable = focusableDialogElements(dialogRef.current)
          if (focusable.length === 0) return
          const first = focusable[0]!
          const last = focusable[focusable.length - 1]!
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }}
      >
        <header>
          <div>
            <span>ELEVENLABS</span>
            <h2 id="speak-title">Speak</h2>
            <p id="speak-description">
              Generate speech onto the notebook as a generate-audio tile with its audio cell below.
            </p>
          </div>
          <button
            type="button"
            className="speak-close"
            aria-label="Close speak dialog"
            disabled={busy}
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>
        <form
          className="speak-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (!busy && canGenerate) onSubmit()
          }}
        >
          <label>
            Text
            <textarea
              value={state.text}
              placeholder={state.loadingVoices ? 'Loading voices…' : 'What should it say?'}
              disabled={busy}
              autoFocus
              onChange={(event) => onText(event.target.value)}
            />
          </label>
          <div className="speak-voices" role="radiogroup" aria-label="Voices">
            {state.loadingVoices && state.voices.length === 0 && (
              <p className="speak-voices-empty">Loading voices…</p>
            )}
            {state.voices.map((voice) => {
              const selected = voice.voiceId === state.voiceId
              return (
                <div
                  key={voice.voiceId}
                  className={selected ? 'speak-voice selected' : 'speak-voice'}
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={busy}
                    onClick={() => selectVoice(voice.voiceId)}
                  >
                    <span className="speak-voice-name">{voice.name}</span>
                    <span className="speak-voice-badge">
                      {voice.source}
                      {voice.category ? ` · ${voice.category}` : ''}
                    </span>
                  </button>
                  {voice.previewUrl && (
                    <button
                      type="button"
                      className="speak-voice-preview"
                      disabled={busy}
                      onClick={() => togglePreview(voice)}
                    >
                      {playingId === voice.voiceId ? 'Pause' : 'Preview'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          {state.warning && (
            <p className="speak-warning">{state.warning}</p>
          )}
          {state.error && <p className="speak-error" role="alert">{state.error}</p>}
          <footer>
            <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="submit" disabled={busy || !canGenerate}>
              {state.submitting ? 'Generating…' : 'Generate'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  )
}

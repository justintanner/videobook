import type { SpeakVoice } from '@/videobook/use-elevenlabs-voices'

export function VoiceOptionList({
  voices,
  selectedVoiceId,
  playingVoiceId,
  disabled = false,
  onSelect,
  onTogglePreview,
}: {
  voices: readonly SpeakVoice[]
  selectedVoiceId: string
  playingVoiceId: string | null
  disabled?: boolean
  onSelect: (voiceId: string) => void
  onTogglePreview: (voiceId: string, previewUrl: string) => void
}) {
  return (
    <>
      {voices.map((voice) => {
        const isSelected = voice.voiceId === selectedVoiceId
        return (
          <div
            key={voice.voiceId}
            className={isSelected ? 'speak-preview-voice selected' : 'speak-preview-voice'}
            role="option"
            aria-selected={isSelected}
            data-voice-id={voice.voiceId}
          >
            <button
              type="button"
              className={isSelected ? 'active speak-preview-select' : 'speak-preview-select'}
              disabled={disabled}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(voice.voiceId)}
            >
              <strong>{voice.name}</strong>
              <span className="speak-preview-badge">
                {voice.source}
                {voice.category ? ` · ${voice.category}` : ''}
              </span>
            </button>
            {voice.previewUrl && (
              <button
                type="button"
                className="speak-preview-play"
                disabled={disabled}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onTogglePreview(voice.voiceId, voice.previewUrl!)}
              >
                {playingVoiceId === voice.voiceId ? 'Pause' : 'Preview'}
              </button>
            )}
          </div>
        )
      })}
    </>
  )
}

export function SpeakCommandPreview({
  voices,
  selectedVoiceId,
  playingVoiceId,
  status,
  warning,
  loading,
  error,
  onSelect,
  onTogglePreview,
  onRefresh,
}: {
  voices: readonly SpeakVoice[]
  selectedVoiceId: string
  playingVoiceId: string | null
  status: 'live' | 'fallback'
  warning: string | null
  loading: boolean
  error: string | null
  onSelect: (voiceId: string) => void
  onTogglePreview: (voiceId: string, previewUrl: string) => void
  onRefresh: () => void
}) {
  const selected = voices.find((voice) => voice.voiceId === selectedVoiceId)

  return (
    <div
      className="command-suggestions speak-preview"
      role="listbox"
      aria-label="ElevenLabs voices"
      data-testid="speak-command-preview"
    >
      {loading && voices.length === 0 && (
        <p className="speak-preview-status">Loading voices…</p>
      )}
      {error && (
        <p className="speak-preview-error" role="alert">{error}</p>
      )}
      <button
        type="button"
        className="speak-preview-refresh"
        disabled={loading}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onRefresh}
      >
        {loading
          ? 'Loading voices…'
          : error
            ? 'Retry voices'
            : voices.length === 0 ? 'Load voices' : 'Refresh voices'}
      </button>
      <VoiceOptionList
        voices={voices}
        selectedVoiceId={selectedVoiceId}
        playingVoiceId={playingVoiceId}
        onSelect={onSelect}
        onTogglePreview={onTogglePreview}
      />
      {(warning || status === 'fallback') && warning && (
        <p className="speak-preview-warning">{warning}</p>
      )}
      <p className="speak-preview-hint">
        ↑↓ voice · tab select · ctrl+space preview · enter speak · esc close
        {selected ? ` · ${selected.name}` : ''}
      </p>
    </div>
  )
}

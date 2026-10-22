import { MediaLibraryAssetPreview } from '@/components/videobook/MediaLibraryAssetPreview'
import type { TranscribeClipChoice } from '@/videobook/transcribe-review'

interface TranscribeBodyProps {
  busy: boolean
  clip: TranscribeClipChoice | null
  choices: readonly TranscribeClipChoice[]
  languageCode: string
  diarize: boolean
  tagAudioEvents: boolean
  estimateUsd: number | null
  estimateLoading: boolean
  estimateUnavailable: boolean
  onClipChange: (assetId: string | null) => void
  onLanguageChange: (languageCode: string) => void
  onDiarizeChange: (diarize: boolean) => void
  onTagAudioEventsChange: (tagAudioEvents: boolean) => void
}

function estimateAmount(usd: number): string {
  return `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`
}

export function TranscribeBody({
  busy,
  clip,
  choices,
  languageCode,
  diarize,
  tagAudioEvents,
  estimateUsd,
  estimateLoading,
  estimateUnavailable,
  onClipChange,
  onLanguageChange,
  onDiarizeChange,
  onTagAudioEventsChange,
}: TranscribeBodyProps) {
  const priced = !estimateLoading && estimateUsd !== null && !estimateUnavailable
  return (
    <div className="confirm-transcribe">
      <section className="confirm-section generation-review-input-section" aria-label="Clip">
        <span className="confirm-section-label">Clip</span>
        {clip ? (
          <div className="generation-review-source">
            <span className="generation-review-source-badge">Input</span>
            <span className="generation-review-source-preview">
              <MediaLibraryAssetPreview
                asset={{
                  type: clip.type,
                  mediaUrl: clip.mediaUrl,
                  thumbnailUrl: clip.thumbnailUrl,
                  duration: clip.duration,
                }}
                eager
              />
            </span>
            <span className="generation-review-source-copy">
              <strong>{clip.label}</strong>
              <small>{clip.type}</small>
            </span>
          </div>
        ) : (
          <div className="generation-review-text-input">
            <span>Input</span>
            <strong>No clip</strong>
            <small>Choose a video or audio clip</small>
          </div>
        )}
      </section>
      <div className="generation-review-editor">
        <section className="generation-review-settings-section" aria-label="Clip choice">
          <div className="generation-review-settings">
            <label>
              <span>Clip</span>
              <select
                aria-label="Clip"
                value={clip?.artifactId ?? ''}
                disabled={busy}
                onChange={(event) => onClipChange(event.target.value || null)}
              >
                <option value="">Choose a clip</option>
                {choices.map((choice) => (
                  <option key={choice.artifactId} value={choice.artifactId}>
                    {choice.label} · {choice.type}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>
        <section className="generation-review-prompt-section" aria-label="Language">
          <div className="generation-review-prompt-field">
            <div className="confirm-section-heading">
              <span>Language</span>
            </div>
            <textarea
              rows={3}
              aria-label="Language"
              placeholder="Auto-detect"
              value={languageCode}
              disabled={busy}
              onChange={(event) => onLanguageChange(event.target.value)}
            />
          </div>
          <p className="muted">
            Leave blank to auto-detect. ElevenLabs returns word timing when an audio track and key are available. Otherwise OpenAI returns a plain transcript.
          </p>
        </section>
        <div className="generation-review-toggles">
          <label className="generation-review-toggle">
            <input
              type="checkbox"
              checked={diarize}
              disabled={busy}
              onChange={(event) => onDiarizeChange(event.target.checked)}
            />
            <span>Diarize speakers</span>
          </label>
          <label className="generation-review-toggle">
            <input
              type="checkbox"
              checked={tagAudioEvents}
              disabled={busy}
              onChange={(event) => onTagAudioEventsChange(event.target.checked)}
            />
            <span>Tag audio events</span>
          </label>
        </div>
      </div>
      <section className="confirm-section generation-review-estimate-section" aria-label="Estimate">
        <span className="confirm-section-label">Estimate</span>
        <strong>
          {estimateLoading ? '…' : priced && estimateUsd !== null ? estimateAmount(estimateUsd) : '—'}
        </strong>
        <span>USD</span>
        <small>
          {estimateLoading
            ? 'Updating estimate…'
            : priced
              ? 'Estimated provider cost'
              : 'Cost estimate unavailable'}
        </small>
      </section>
    </div>
  )
}

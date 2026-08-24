import { Film } from 'lucide-react'
import {
  defaultXPostScheduledFor,
  X_POST_MAX_CHARACTERS,
  xPostIsoDateTimeValue,
  xPostLocalDateTimeValue,
  type XPostDraft,
  type XPostDraftPatch,
} from '@/videobook/x-post-review'

type PostToXPreviewAsset = {
  type: string
  mediaUrl: string | null
  thumbnailUrl: string | null
}

export function PostToXChatPreview({
  asset,
  busy,
  draft,
  error,
  onChange,
  sourceLabel,
}: {
  asset: PostToXPreviewAsset | null
  busy: boolean
  draft: XPostDraft
  error: string | null
  onChange: (patch: XPostDraftPatch) => void
  sourceLabel: string
}) {
  const video = asset?.type === 'video' || asset?.type === 'final'
  const imageUrl = asset?.type === 'image'
    ? asset.mediaUrl ?? asset.thumbnailUrl
    : null
  const scheduled = draft.scheduledFor !== null

  return (
    <article className="x-post-chat-preview" aria-label="X post preview">
      <header>
        <span aria-hidden>X</span>
        <div>
          <strong>Post preview</strong>
          <small>{sourceLabel}</small>
        </div>
      </header>
      <div className="x-post-chat-preview-media">
        {video && asset?.mediaUrl ? (
          <video
            src={asset.mediaUrl}
            poster={asset.thumbnailUrl ?? undefined}
            controls
            playsInline
            preload="metadata"
          />
        ) : imageUrl ? (
          <img src={imageUrl} alt={`${sourceLabel} post preview`} />
        ) : (
          <div className="x-post-chat-preview-fallback">
            <Film size={28} aria-hidden />
            <span>Media preview unavailable</span>
          </div>
        )}
      </div>
      <div className="x-post-chat-preview-copy">
        <label htmlFor="x-post-message">Message</label>
        <textarea
          id="x-post-message"
          aria-invalid={draft.postText.length > X_POST_MAX_CHARACTERS}
          disabled={busy}
          maxLength={X_POST_MAX_CHARACTERS}
          placeholder="No message — media only"
          rows={4}
          value={draft.postText}
          onChange={(event) => onChange({ postText: event.target.value })}
        />
        <small>{draft.postText.length}/{X_POST_MAX_CHARACTERS} characters</small>
      </div>
      <div
        className="x-post-chat-preview-options"
        role="group"
        aria-label="Post options"
      >
        <label>
          <span>Publish</span>
          <select
            aria-label="Publish timing"
            disabled={busy}
            value={scheduled ? 'schedule' : 'now'}
            onChange={(event) => onChange({
              scheduledFor: event.target.value === 'schedule'
                ? defaultXPostScheduledFor()
                : null,
            })}
          >
            <option value="now">Now</option>
            <option value="schedule">Schedule</option>
          </select>
        </label>
        <label>
          <span>Orientation</span>
          <select
            aria-label="Video orientation"
            disabled={busy || asset?.type === 'image'}
            value={draft.orientation ?? 'source'}
            onChange={(event) => onChange({
              orientation: event.target.value === 'portrait'
                || event.target.value === 'landscape'
                ? event.target.value
                : null,
            })}
          >
            <option value="source">Keep source</option>
            <option value="portrait">Portrait</option>
            <option value="landscape">Landscape</option>
          </select>
          {asset?.type === 'image' && <small>Video posts only</small>}
        </label>
        {scheduled && (
          <label className="x-post-chat-preview-schedule">
            <span>Date and time</span>
            <input
              aria-label="Schedule date and time"
              disabled={busy}
              required
              type="datetime-local"
              value={xPostLocalDateTimeValue(draft.scheduledFor ?? '')}
              onChange={(event) => onChange({
                scheduledFor: xPostIsoDateTimeValue(event.target.value),
              })}
            />
            <small>Uses your local timezone</small>
          </label>
        )}
      </div>
      {error && (
        <p className="x-post-chat-preview-error" role="alert">{error}</p>
      )}
    </article>
  )
}

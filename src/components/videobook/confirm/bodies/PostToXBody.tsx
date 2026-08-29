import { Film } from 'lucide-react'
import type { RoutedActionSetting } from '@/videobook/chat-action-review'
import {
  defaultXPostScheduledFor,
  X_POST_MAX_CHARACTERS,
  xPostIsoDateTimeValue,
  xPostLocalDateTimeValue,
  type XPostDraft,
  type XPostDraftPatch,
} from '@/videobook/x-post-review'
import { PromptEcho, RoutedSettings } from './RoutedSettings'

type PostToXPreviewAsset = {
  type: string
  mediaUrl: string | null
  thumbnailUrl: string | null
}

export function PostToXBody({
  asset,
  busy,
  draft,
  onChange,
  prompt,
  settings,
  sourceLabel,
}: {
  asset: PostToXPreviewAsset | null
  busy: boolean
  draft: XPostDraft
  onChange: (patch: XPostDraftPatch) => void
  prompt: string
  settings: readonly RoutedActionSetting[]
  sourceLabel: string
}) {
  const video = asset?.type === 'video' || asset?.type === 'final'
  const imageUrl = asset?.type === 'image'
    ? asset.mediaUrl ?? asset.thumbnailUrl
    : null
  const scheduled = draft.scheduledFor !== null
  const tooLong = draft.postText.length > X_POST_MAX_CHARACTERS

  return (
    <div className="confirm-routed confirm-post">
      <div className="confirm-routed-main">
        <PromptEcho prompt={prompt} />
        <RoutedSettings columns={2} settings={settings} />
      </div>
      <article className="x-post-preview" aria-label="X post preview">
        <header>
          <span aria-hidden="true">X</span>
          <div>
            <strong>Post preview</strong>
            <small>{sourceLabel}</small>
          </div>
        </header>
        <div className="x-post-preview-media">
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
            <div className="x-post-preview-fallback">
              <Film size={28} aria-hidden="true" />
              <span>Media preview unavailable</span>
            </div>
          )}
        </div>
        <div className="x-post-preview-copy">
          <label htmlFor="x-post-message">Message</label>
          <textarea
            id="x-post-message"
            aria-invalid={tooLong}
            disabled={busy}
            placeholder="No message — media only"
            rows={3}
            value={draft.postText}
            onChange={(event) => onChange({ postText: event.target.value })}
          />
          <small className={tooLong ? 'confirm-field-error' : undefined}>
            {draft.postText.length}/{X_POST_MAX_CHARACTERS} characters
          </small>
        </div>
        <div
          className="x-post-preview-options"
          role="group"
          aria-label="Post options"
        >
          <label className="confirm-field">
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
          <label className="confirm-field">
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
            <label className="confirm-field">
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
      </article>
    </div>
  )
}

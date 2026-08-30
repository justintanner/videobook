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
import {
  buildXPostThreadReplies,
  type XPostThreadOptions,
  type XPostThreadReview,
} from '@/videobook/x-post-thread'
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
  onThreadOptionsChange,
  onThreadReplyChange,
  prompt,
  settings,
  sourceLabel,
  threadReview,
}: {
  asset: PostToXPreviewAsset | null
  busy: boolean
  draft: XPostDraft
  onChange: (patch: XPostDraftPatch) => void
  onThreadOptionsChange?: (patch: Partial<XPostThreadOptions>) => void
  onThreadReplyChange?: (replyId: string, text: string) => void
  prompt: string
  settings: readonly RoutedActionSetting[]
  sourceLabel: string
  threadReview?: XPostThreadReview | null
}) {
  const video = asset?.type === 'video' || asset?.type === 'final'
  const imageUrl = asset?.type === 'image'
    ? asset.mediaUrl ?? asset.thumbnailUrl
    : null
  const scheduled = draft.scheduledFor !== null
  const tooLong = draft.postText.length > X_POST_MAX_CHARACTERS
  const threadReplies = threadReview
    ? buildXPostThreadReplies(threadReview)
    : []
  const threadAvailable = threadReview !== null
    && threadReview !== undefined
    && (threadReview.context.steps.some((step) =>
      Boolean(step.prompt) || step.images.length > 0)
      || threadReview.context.attributions.length > 0)

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
        {video && threadReview && (
          <section className="x-post-thread" aria-label="How it was made thread">
            <label className="x-post-thread-master">
              <input
                type="checkbox"
                checked={threadReview.options.enabled}
                disabled={busy || threadReview.loading || !threadAvailable}
                onChange={(event) => onThreadOptionsChange?.({
                  enabled: event.target.checked,
                })}
              />
              <span>
                <strong>Add how-it-was-made thread</strong>
                <small>Post editable replies after the video</small>
              </span>
            </label>
            {threadReview.loading ? (
              <small>Loading generation details…</small>
            ) : threadReview.error ? (
              <small className="confirm-field-error">{threadReview.error}</small>
            ) : !threadAvailable ? (
              <small>No generation details or original source links were found.</small>
            ) : threadReview.options.enabled ? (
              <>
                <div className="x-post-thread-options" role="group" aria-label="Thread options">
                  <label>
                    <input
                      type="checkbox"
                      checked={threadReview.options.includePrompt}
                      disabled={busy || threadReview.context.steps.every((step) =>
                        !step.prompt)}
                      onChange={(event) => onThreadOptionsChange?.({
                        includePrompt: event.target.checked,
                      })}
                    />
                    Include prompts
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={threadReview.options.includeSourceImages}
                      disabled={busy || threadReview.context.steps.every((step) =>
                        step.images.length === 0)}
                      onChange={(event) => onThreadOptionsChange?.({
                        includeSourceImages: event.target.checked,
                      })}
                    />
                    Attach source images
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={threadReview.options.includeAttribution}
                      disabled={busy || threadReview.context.attributions.length === 0}
                      onChange={(event) => onThreadOptionsChange?.({
                        includeAttribution: event.target.checked,
                      })}
                    />
                    Credit original sources
                  </label>
                </div>
                <div className="x-post-thread-replies">
                  {threadReplies.map((reply, index) => {
                    const replyTooLong = reply.text.length > X_POST_MAX_CHARACTERS
                    return (
                      <article key={reply.id} className="x-post-thread-reply">
                        <div>
                          <label htmlFor={`x-post-followup-${index}`}>Follow-up {index + 1}</label>
                          <small className={replyTooLong ? 'confirm-field-error' : undefined}>
                            {reply.text.length}/{X_POST_MAX_CHARACTERS}
                          </small>
                        </div>
                        <textarea
                          id={`x-post-followup-${index}`}
                          aria-invalid={replyTooLong}
                          disabled={busy}
                          rows={3}
                          value={reply.text}
                          onChange={(event) => onThreadReplyChange?.(
                            reply.id,
                            event.target.value,
                          )}
                        />
                        {reply.images.length > 0 && (
                          <div className="x-post-thread-images">
                            {reply.images.map((image) => (
                              <figure key={image.assetId}>
                                <img
                                  src={image.thumbnailUrl ?? image.mediaUrl ?? undefined}
                                  alt={image.label}
                                />
                                <figcaption>{image.label}</figcaption>
                              </figure>
                            ))}
                          </div>
                        )}
                      </article>
                    )
                  })}
                  {threadReplies.length === 0 && (
                    <small>Select at least one thread detail to add a reply.</small>
                  )}
                </div>
              </>
            ) : null}
          </section>
        )}
      </article>
    </div>
  )
}

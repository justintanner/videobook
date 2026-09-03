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
  X_POST_EMPTY_THREAD_MESSAGE,
  xPostThreadCreditsText,
  xPostThreadHasDetails,
  xPostThreadPrompt,
  type XPostThreadOptions,
  type XPostThreadReview,
  type XPostThreadStep,
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
  onThreadCreditsChange,
  onThreadOptionsChange,
  onThreadPromptChange,
  prompt,
  settings,
  sourceLabel,
  threadReview,
}: {
  asset: PostToXPreviewAsset | null
  busy: boolean
  draft: XPostDraft
  onChange: (patch: XPostDraftPatch) => void
  onThreadCreditsChange?: (text: string) => void
  onThreadOptionsChange?: (patch: Partial<XPostThreadOptions>) => void
  onThreadPromptChange?: (stepId: string, text: string) => void
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
  const threadAvailable = threadReview
    ? xPostThreadHasDetails(threadReview.context)
    : false

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
                <small>Reply with the model, prompt, input images and credits</small>
              </span>
            </label>
            {threadReview.loading ? (
              <small>Loading generation details…</small>
            ) : threadReview.error ? (
              <small className="confirm-field-error">{threadReview.error}</small>
            ) : !threadAvailable ? (
              <small>No generation details were found.</small>
            ) : threadReview.options.enabled ? (
              <div className="x-post-thread-steps">
                {threadReview.context.steps.map((step, index) => (
                  <ThreadStep
                    key={step.id}
                    busy={busy}
                    index={index}
                    prompt={xPostThreadPrompt(threadReview, step)}
                    replyCount={threadReplies.filter((reply) =>
                      reply.stepId === step.id).length}
                    step={step}
                    stepCount={threadReview.context.steps.length}
                    onPromptChange={onThreadPromptChange}
                  />
                ))}
                {threadReview.context.credits.length > 0 && (
                  <ThreadCredits
                    busy={busy}
                    replyCount={threadReplies.filter((reply) =>
                      reply.stepId === null).length}
                    text={xPostThreadCreditsText(threadReview)}
                    onChange={onThreadCreditsChange}
                  />
                )}
                {threadReplies.length === 0 && (
                  <small className="confirm-field-error">
                    {X_POST_EMPTY_THREAD_MESSAGE}
                  </small>
                )}
              </div>
            ) : null}
          </section>
        )}
      </article>
    </div>
  )
}

function replyCountLabel(count: number): string {
  if (count === 0) return 'nothing to post'
  return `posts as ${count} ${count === 1 ? 'reply' : 'replies'}`
}

function ThreadStep({
  busy,
  index,
  onPromptChange,
  prompt,
  replyCount,
  step,
  stepCount,
}: {
  busy: boolean
  index: number
  onPromptChange?: (stepId: string, text: string) => void
  prompt: string
  replyCount: number
  step: XPostThreadStep
  stepCount: number
}) {
  const promptId = `x-post-thread-prompt-${index}`
  return (
    <article
      className="x-post-thread-step"
      aria-label={stepCount > 1 ? `Generation step ${index + 1}` : 'Generation step'}
    >
      {stepCount > 1 && (
        <small className="x-post-thread-step-ordinal">
          Step {index + 1} of {stepCount}
        </small>
      )}
      {step.model && (
        <div className="x-post-thread-field">
          <span className="x-post-thread-label">Model</span>
          <p className="x-post-thread-model">
            <span>{step.model.label}</span>
            {step.model.provider && <small>via {step.model.provider}</small>}
          </p>
        </div>
      )}
      <div className="x-post-thread-field">
        <div className="x-post-thread-field-head">
          <label className="x-post-thread-label" htmlFor={promptId}>Prompt</label>
          <small>{prompt.length} characters · {replyCountLabel(replyCount)}</small>
        </div>
        <textarea
          id={promptId}
          disabled={busy}
          rows={4}
          value={prompt}
          onChange={(event) => onPromptChange?.(step.id, event.target.value)}
        />
      </div>
      {step.images.length > 0 && (
        <div className="x-post-thread-field">
          <span className="x-post-thread-label">Input images</span>
          <div className="x-post-thread-images">
            {step.images.map((image) => (
              <figure key={image.assetId}>
                <img
                  src={image.thumbnailUrl ?? image.mediaUrl ?? undefined}
                  alt={image.label}
                />
                <figcaption>{image.label}</figcaption>
              </figure>
            ))}
          </div>
        </div>
      )}
    </article>
  )
}

function ThreadCredits({
  busy,
  onChange,
  replyCount,
  text,
}: {
  busy: boolean
  onChange?: (text: string) => void
  replyCount: number
  text: string
}) {
  const tooLong = text.length > X_POST_MAX_CHARACTERS
  return (
    <article className="x-post-thread-step" aria-label="Credits">
      <div className="x-post-thread-field">
        <div className="x-post-thread-field-head">
          <label className="x-post-thread-label" htmlFor="x-post-thread-credits">Credits</label>
          <small className={tooLong ? 'confirm-field-error' : undefined}>
            {text.length}/{X_POST_MAX_CHARACTERS} characters · {replyCountLabel(replyCount)}
          </small>
        </div>
        <textarea
          id="x-post-thread-credits"
          aria-invalid={tooLong}
          disabled={busy}
          rows={2}
          value={text}
          onChange={(event) => onChange?.(event.target.value)}
        />
      </div>
    </article>
  )
}

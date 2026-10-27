import { Film } from 'lucide-react'
import type { RoutedActionSetting } from '@/videobook/chat-action-review'
import {
  defaultXPostScheduledFor,
  xPostIsoDateTimeValue,
  xPostLocalDateTimeValue,
  type XPostDraft,
  type XPostDraftPatch,
} from '@/videobook/x-post-review'
import {
  buildXPostThreadReplies,
  X_POST_EMPTY_THREAD_MESSAGE,
  xPostThreadAttachedImages,
  xPostThreadCreditsText,
  xPostThreadHasDetails,
  xPostThreadPrompt,
  type XPostThreadOptions,
  type XPostThreadReply,
  type XPostThreadReview,
  type XPostThreadStep,
} from '@/videobook/x-post-thread'
import {
  xConnectionAccountDetail,
  xConnectionPresentation,
  xPostMaxCharacters,
  type XConnectionState,
} from '@/videobook/x-connection'
import type { DeliveryDestination } from '@/videobook/post-delivery-review'
import { PromptEcho, RoutedSettings } from './RoutedSettings'
import './PostDeliveryBody.css'

type PostToXPreviewAsset = {
  type: string
  mediaUrl: string | null
  thumbnailUrl: string | null
}

export function PostToXBody({
  asset,
  busy,
  connection,
  draft,
  onChange,
  onConnect,
  onDestination,
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
  connection?: XConnectionState | null
  draft: XPostDraft
  onChange: (patch: XPostDraftPatch) => void
  onConnect?: () => void
  onDestination?: (destination: DeliveryDestination) => void
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
  const untitled = draft.postText.trim() === ''
  const maxCharacters = xPostMaxCharacters(connection?.status ?? null)
  const accountDetail = connection?.status
    ? xConnectionAccountDetail(connection.status)
    : null
  const tooLong = draft.postText.length > maxCharacters
  const threadReplies = threadReview
    ? buildXPostThreadReplies(threadReview)
    : []
  const threadAvailable = threadReview
    ? xPostThreadHasDetails(threadReview.context)
    : false
  const connectionNotice = connection?.status
    ? xConnectionPresentation(connection.status, { connecting: connection.connecting })
    : null
  const showConnectionNotice = connectionNotice !== null
    && connectionNotice.tone !== 'connected'

  return (
    <div className="confirm-routed confirm-post">
      <div className="confirm-routed-main">
        {onDestination && (
          <div className="post-delivery-switch" role="group" aria-label="Destination">
            <button type="button" aria-pressed={false} disabled={busy} onClick={() => onDestination('icloud')}>iCloud · iPhone</button>
            <button type="button" aria-pressed={false} disabled={busy} onClick={() => onDestination('download')}>Download</button>
            <button type="button" aria-pressed={true} disabled={busy}>X</button>
          </div>
        )}
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
        {showConnectionNotice && connectionNotice && (
          <div
            className={`x-post-connection x-post-connection-${connectionNotice.tone}`}
            role="status"
            aria-label="X connection"
          >
            <div>
              <strong>{connectionNotice.label}</strong>
              <span>{connectionNotice.detail}</span>
              {connection?.connecting && connection.authorizeUrl && (
                <a href={connection.authorizeUrl} target="_blank" rel="noopener noreferrer">
                  Open the X authorization page
                </a>
              )}
            </div>
            {onConnect && (connectionNotice.actionLabel || connection?.connecting) && (
              <button
                type="button"
                disabled={busy || connection?.connecting}
                onClick={onConnect}
              >
                {connection?.connecting ? 'Waiting…' : connectionNotice.actionLabel}
              </button>
            )}
          </div>
        )}
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
          <label htmlFor="x-post-title">Title</label>
          <textarea
            id="x-post-title"
            aria-invalid={untitled || tooLong}
            disabled={busy}
            placeholder="Title (required)"
            required
            rows={3}
            value={draft.postText}
            onChange={(event) => onChange({ postText: event.target.value })}
          />
          <small className={untitled || tooLong ? 'confirm-field-error' : undefined}>
            {untitled
              ? 'A title is required'
              : `${draft.postText.length}/${maxCharacters} characters`}
          </small>
          {accountDetail && <small className="x-post-account">{accountDetail}</small>}
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
                <small>
                  Reply with the prompt and input images, then thank the original video
                </small>
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
                    maxCharacters={maxCharacters}
                    prompt={xPostThreadPrompt(threadReview, step)}
                    reply={threadReplies.find((reply) =>
                      reply.stepId === step.id) ?? null}
                    step={step}
                    stepCount={threadReview.context.steps.length}
                    onPromptChange={onThreadPromptChange}
                  />
                ))}
                {threadReview.context.credits.length > 0 && (
                  <ThreadCredits
                    busy={busy}
                    maxCharacters={maxCharacters}
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

function attachedImagesLabel(step: XPostThreadStep): string {
  const attached = xPostThreadAttachedImages(step.images).length
  if (attached === step.images.length) return 'Input images'
  return `Input images · first ${attached} of ${step.images.length} attach`
}

function ThreadStep({
  busy,
  index,
  maxCharacters,
  onPromptChange,
  prompt,
  reply,
  step,
  stepCount,
}: {
  busy: boolean
  index: number
  maxCharacters: number
  onPromptChange?: (stepId: string, text: string) => void
  prompt: string
  reply: XPostThreadReply | null
  step: XPostThreadStep
  stepCount: number
}) {
  const promptId = `x-post-thread-prompt-${index}`
  const replyLength = reply?.text.length ?? 0
  const tooLong = replyLength > maxCharacters
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
          <small className={tooLong ? 'confirm-field-error' : undefined}>
            {replyLength}/{maxCharacters} characters with heading
            {' · '}
            {replyCountLabel(reply ? 1 : 0)}
          </small>
        </div>
        <textarea
          id={promptId}
          aria-invalid={tooLong}
          disabled={busy}
          rows={4}
          value={prompt}
          onChange={(event) => onPromptChange?.(step.id, event.target.value)}
        />
      </div>
      {step.images.length > 0 && (
        <div className="x-post-thread-field">
          <span className="x-post-thread-label">{attachedImagesLabel(step)}</span>
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
  maxCharacters,
  onChange,
  replyCount,
  text,
}: {
  busy: boolean
  maxCharacters: number
  onChange?: (text: string) => void
  replyCount: number
  text: string
}) {
  const tooLong = text.length > maxCharacters
  return (
    <article className="x-post-thread-step" aria-label="Credits">
      <div className="x-post-thread-field">
        <div className="x-post-thread-field-head">
          <label className="x-post-thread-label" htmlFor="x-post-thread-credits">Credits</label>
          <small className={tooLong ? 'confirm-field-error' : undefined}>
            {text.length}/{maxCharacters} characters · {replyCountLabel(replyCount)}
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

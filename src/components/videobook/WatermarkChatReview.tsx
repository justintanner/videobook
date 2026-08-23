import { useState } from 'react'
import type { CSSProperties } from 'react'
import { Check, QrCode, X } from 'lucide-react'
import { WATERMARK_POSITIONS } from '@/videobook/watermark-review'
import type { WatermarkPosition } from '@/videobook/watermark-review'

export interface WatermarkReviewState {
  assetId: string
  targetLabel: string
  mediaUrl: string | null
  thumbnailUrl: string | null
  width: number | null
  height: number | null
  durationSeconds: number | null
  handle: string
  url: string
  includeQr: boolean
  position: WatermarkPosition
  startSeconds: number
  endSeconds: number | null
  saveDefault: boolean
  recent: string[]
  loadingConfig: boolean
  error: string | null
}

export type WatermarkReviewPatch = Partial<Pick<WatermarkReviewState,
  | 'handle'
  | 'url'
  | 'includeQr'
  | 'position'
  | 'startSeconds'
  | 'endSeconds'
  | 'saveDefault'
>>

type MediaMetadata = {
  durationSeconds: number
  width: number
  height: number
}

const POSITION_LABELS: Record<(typeof WATERMARK_POSITIONS)[number], string> = {
  'top-left': 'Top left',
  'top-center': 'Top center',
  'top-right': 'Top right',
  'middle-left': 'Middle left',
  'middle-center': 'Middle center',
  'middle-right': 'Middle right',
  'bottom-left': 'Bottom left',
  'bottom-center': 'Bottom center',
  'bottom-right': 'Bottom right',
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function secondsLabel(value: number): string {
  if (!Number.isFinite(value)) return '0.0s'
  return `${value.toFixed(1)}s`
}

function previewBadgeStyle(
  position: Exclude<WatermarkPosition, 'auto'>,
  includeQr: boolean,
  width: number,
  height: number,
): CSSProperties {
  const [vertical, horizontal] = position.split('-')
  const transforms: string[] = []
  const style: CSSProperties = {
    aspectRatio: includeQr ? '480 / 580' : '480 / 88',
    height: `${16 * (Math.min(width, height) / height)}%`,
  }
  if (horizontal === 'left') style.left = '2%'
  if (horizontal === 'right') style.right = '2%'
  if (horizontal === 'center') {
    style.left = '50%'
    transforms.push('translateX(-50%)')
  }
  const verticalInset = `${2 * (width / height)}%`
  if (vertical === 'top') style.top = verticalInset
  if (vertical === 'bottom') style.bottom = verticalInset
  if (vertical === 'middle') {
    style.top = '50%'
    transforms.push('translateY(-50%)')
  }
  if (transforms.length > 0) style.transform = transforms.join(' ')
  return style
}

export function WatermarkChatReview({
  applyFormId,
  busy,
  state,
  onChange,
  onMediaMetadata,
  onCancel,
}: {
  applyFormId: string
  busy: boolean
  state: WatermarkReviewState
  onChange: (patch: WatermarkReviewPatch) => void
  onMediaMetadata: (metadata: MediaMetadata) => void
  onCancel: () => void
}) {
  const [currentTime, setCurrentTime] = useState(0)
  const handle = state.handle.replace(/^@/, '').trim()
  const urlPlaceholder = handle ? `https://x.com/${handle}` : 'https://x.com/<handle>'
  const duration = state.durationSeconds ?? 0
  const effectiveEnd = state.endSeconds ?? duration
  const timingValid = state.endSeconds !== null
    ? state.endSeconds > state.startSeconds
    : duration <= 0 || state.startSeconds < duration
  const visibleAtPlayhead = currentTime >= state.startSeconds
    && (state.endSeconds === null || currentTime <= state.endSeconds)
  const previewPosition = state.position === 'auto' ? 'bottom-right' : state.position
  const previewWidth = state.width !== null && state.width > 0 ? state.width : 16
  const previewHeight = state.height !== null && state.height > 0 ? state.height : 9
  const tallPreview = previewHeight >= previewWidth
  const timelineStart = duration > 0
    ? clamp((state.startSeconds / duration) * 100, 0, 100)
    : 0
  const timelineEnd = duration > 0
    ? clamp((effectiveEnd / duration) * 100, timelineStart, 100)
    : 100
  const playhead = duration > 0
    ? clamp((currentTime / duration) * 100, 0, 100)
    : 0

  return (
    <aside
      className="command-plan-drawer watermark-chat-review"
      aria-label="Watermark review"
      aria-keyshortcuts="Escape"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || busy) return
        event.preventDefault()
        event.stopPropagation()
        onCancel()
      }}
    >
      <header>
        <div className="command-plan-heading">
          <span className="section-label">WATERMARK · CHAT</span>
          <h2>Watermark {state.targetLabel}</h2>
        </div>
        <div className="command-plan-primary-actions">
          <button
            type="submit"
            form={applyFormId}
            className="command-plan-apply"
            disabled={busy || !handle || !timingValid}
          >
            <Check size={14} />{busy ? 'Applying…' : 'Apply'}
          </button>
          <button type="button" disabled={busy} onClick={onCancel}>
            <X size={14} />Cancel
          </button>
        </div>
      </header>

      <div className="watermark-editor">
        <section className="watermark-preview-section">
          <div className="watermark-section-heading">
            <span>Preview</span>
            <strong>{secondsLabel(currentTime)} / {duration > 0 ? secondsLabel(duration) : '—'}</strong>
          </div>
          <div
            className={`watermark-video-stage${tallPreview ? ' tall' : ' wide'}`}
            style={{ aspectRatio: `${previewWidth} / ${previewHeight}` }}
          >
            {state.mediaUrl ? (
              <video
                src={state.mediaUrl}
                poster={state.thumbnailUrl ?? undefined}
                controls
                playsInline
                preload="metadata"
                onLoadedMetadata={(event) => {
                  const video = event.currentTarget
                  if (
                    Number.isFinite(video.duration)
                    && video.duration > 0
                    && video.videoWidth > 0
                    && video.videoHeight > 0
                  ) {
                    onMediaMetadata({
                      durationSeconds: video.duration,
                      width: video.videoWidth,
                      height: video.videoHeight,
                    })
                  }
                }}
                onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                onSeeked={(event) => setCurrentTime(event.currentTarget.currentTime)}
              />
            ) : state.thumbnailUrl ? (
              <img src={state.thumbnailUrl} alt="" />
            ) : (
              <span className="watermark-preview-empty">Video preview unavailable</span>
            )}
            <div
              className={`watermark-preview-badge${state.includeQr ? ' with-qr' : ' handle-only'}${visibleAtPlayhead ? '' : ' outside-window'}`}
              style={previewBadgeStyle(
                previewPosition,
                state.includeQr,
                previewWidth,
                previewHeight,
              )}
              aria-hidden="true"
            >
              {state.includeQr && (
                <span className="watermark-preview-qr"><QrCode /></span>
              )}
              <span className="watermark-preview-handle">
                <b>𝕏</b>
                <span>@{handle || 'handle'}</span>
              </span>
            </div>
            {state.position === 'auto' && (
              <span className="watermark-auto-preview">AUTO · previewing bottom right</span>
            )}
          </div>
          <div className="watermark-timeline" aria-label="Watermark visibility timeline">
            <span
              className="watermark-timeline-window"
              style={{ left: `${timelineStart}%`, width: `${timelineEnd - timelineStart}%` }}
            />
            <span
              className="watermark-timeline-playhead"
              style={{ left: `${playhead}%` }}
            />
          </div>
          <div className="watermark-preview-readout">
            <span>{state.position === 'auto' ? 'Auto placement' : POSITION_LABELS[state.position]}</span>
            <span>{secondsLabel(state.startSeconds)} → {duration > 0 ? secondsLabel(effectiveEnd) : 'clip end'}</span>
            <span>{state.includeQr ? 'QR + handle' : 'Handle only'}</span>
            <span>Rebuilds playable proxy</span>
          </div>
        </section>

        <div className="watermark-controls">
          <section className="watermark-control-section">
            <span className="watermark-section-label">Identity</span>
            <label>
              X handle
              <div className="watermark-handle-field">
                <span aria-hidden="true">@</span>
                <input
                  type="text"
                  value={state.handle}
                  placeholder={state.loadingConfig ? 'Loading…' : 'handle'}
                  disabled={busy}
                  onChange={(event) => onChange({ handle: event.target.value })}
                />
              </div>
            </label>
            {state.recent.length > 0 && (
              <div className="watermark-recent" role="group" aria-label="Recent handles">
                {state.recent.map((recentHandle) => (
                  <button
                    key={recentHandle}
                    type="button"
                    className={recentHandle === handle ? 'active' : ''}
                    disabled={busy}
                    onClick={() => onChange({ handle: recentHandle })}
                  >
                    @{recentHandle}
                  </button>
                ))}
              </div>
            )}
            <label className="watermark-toggle">
              <span>
                <strong>Include QR code</strong>
                <small>Add a scannable link above the handle</small>
              </span>
              <input
                type="checkbox"
                checked={state.includeQr}
                disabled={busy}
                onChange={(event) => onChange({ includeQr: event.target.checked })}
              />
            </label>
            {state.includeQr && (
              <label>
                QR link
                <input
                  type="text"
                  value={state.url}
                  placeholder={urlPlaceholder}
                  disabled={busy}
                  onChange={(event) => onChange({ url: event.target.value })}
                />
              </label>
            )}
          </section>

          <section className="watermark-control-section">
            <div className="watermark-section-heading">
              <span>Position</span>
              <button
                type="button"
                className={state.position === 'auto' ? 'active' : ''}
                aria-pressed={state.position === 'auto'}
                disabled={busy}
                onClick={() => onChange({ position: 'auto' })}
              >
                Auto
              </button>
            </div>
            <div className="watermark-position-grid" role="group" aria-label="Watermark position">
              {WATERMARK_POSITIONS.map((position) => (
                <button
                  key={position}
                  type="button"
                  className={state.position === position ? 'active' : ''}
                  aria-label={POSITION_LABELS[position]}
                  aria-pressed={state.position === position}
                  title={POSITION_LABELS[position]}
                  disabled={busy}
                  onClick={() => onChange({ position })}
                >
                  <span />
                </button>
              ))}
            </div>
            <small className="watermark-control-help">
              Auto checks the clip for faces and text. Pick a point to lock the preview and output.
            </small>
          </section>

          <section className="watermark-control-section">
            <div className="watermark-section-heading">
              <span>Timing</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => onChange({ startSeconds: 0, endSeconds: null })}
              >
                Whole clip
              </button>
            </div>
            <div className="watermark-time-fields">
              <label>
                Start
                <input
                  type="number"
                  min="0"
                  max={duration > 0 ? duration : undefined}
                  step="0.1"
                  value={state.startSeconds}
                  disabled={busy}
                  onChange={(event) => onChange({
                    startSeconds: Math.max(0, Number(event.target.value) || 0),
                  })}
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onChange({
                    startSeconds: state.endSeconds === null
                      ? currentTime
                      : Math.min(currentTime, Math.max(0, state.endSeconds - 0.1)),
                  })}
                >
                  Set from playhead
                </button>
              </label>
              <label>
                End
                <input
                  type="number"
                  min="0"
                  max={duration > 0 ? duration : undefined}
                  step="0.1"
                  value={state.endSeconds ?? ''}
                  placeholder={duration > 0 ? duration.toFixed(1) : 'Clip end'}
                  disabled={busy}
                  onChange={(event) => onChange({
                    endSeconds: event.target.value === ''
                      ? null
                      : Math.max(0, Number(event.target.value) || 0),
                  })}
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onChange({
                    endSeconds: Math.max(currentTime, state.startSeconds + 0.1),
                  })}
                >
                  Set from playhead
                </button>
              </label>
            </div>
            {!timingValid && (
              <p className="watermark-error" role="alert">End time must be after start time.</p>
            )}
          </section>

          <label className="watermark-save-default">
            <input
              type="checkbox"
              checked={state.saveDefault}
              disabled={busy}
              onChange={(event) => onChange({ saveDefault: event.target.checked })}
            />
            Save as default handle
          </label>
          {state.error && <p className="watermark-error" role="alert">{state.error}</p>}
        </div>
      </div>
    </aside>
  )
}

import { useState } from 'react'
import type { CSSProperties } from 'react'
import { Check, X } from 'lucide-react'
import {
  MAX_HANDLE_VERTICAL_PERCENT,
  MAX_WATERMARK_OPACITY,
  MIN_HANDLE_VERTICAL_PERCENT,
  MIN_WATERMARK_OPACITY,
  WATERMARK_POSITIONS,
} from '@/videobook/watermark-review'
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
  handleVerticalPercent: number
  includeXIcon: boolean
  includeHandleBorder: boolean
  qrOpacity: number
  handleOpacity: number
  qrStartSeconds: number
  qrEndSeconds: number | null
  handleStartSeconds: number
  handleEndSeconds: number | null
  saveDefault: boolean
  recent: string[]
  loadingConfig: boolean
  error: string | null
}

type WatermarkReviewPatch = Partial<Pick<WatermarkReviewState,
  | 'handle'
  | 'url'
  | 'includeQr'
  | 'position'
  | 'handleVerticalPercent'
  | 'includeXIcon'
  | 'includeHandleBorder'
  | 'qrOpacity'
  | 'handleOpacity'
  | 'qrStartSeconds'
  | 'qrEndSeconds'
  | 'handleStartSeconds'
  | 'handleEndSeconds'
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

const QR_PREVIEW_ROWS = [
  'fe2601bf8',
  '8209bd208',
  'ba34532e8',
  'ba6ee3ae8',
  'ba95bfae8',
  '824f55208',
  'feaaaabf8',
  '00ccb8800',
  '33c3ed680',
  '646dcd668',
  '8abc29c48',
  'f976883d0',
  '2bd10cc08',
  '246bc6840',
  '3ae7049a0',
  '78227f738',
  '1fa124fc0',
  'b072db3a8',
  'f715de7b0',
  'a150ca198',
  '7aac44a60',
  'ed6a62858',
  '060607bf8',
  '5d2a6a4c8',
  'aa0132f80',
  '0087658f0',
  'fe9a35ac0',
  '8277d98f8',
  'ba51bbff0',
  'bacc3e160',
  'ba9403e00',
  '824b0bc28',
  'fe263c180',
] as const

const QR_PREVIEW_SIZE = QR_PREVIEW_ROWS.length
const X_LOGO_PATH = 'M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z'

function buildQrPreviewPath(): string {
  const modules: string[] = []
  for (let row = 0; row < QR_PREVIEW_SIZE; row += 1) {
    const encodedRow = QR_PREVIEW_ROWS[row]
    for (let column = 0; column < QR_PREVIEW_SIZE; column += 1) {
      const nibble = Number.parseInt(encodedRow.charAt(Math.floor(column / 4)), 16)
      if ((nibble & (8 >> (column % 4))) !== 0) {
        modules.push(`M${column} ${row}h1v1h-1z`)
      }
    }
  }
  return modules.join('')
}

const QR_PREVIEW_PATH = buildQrPreviewPath()

function WatermarkQrPreview() {
  return (
    <svg
      className="watermark-preview-qr-modules"
      viewBox={`0 0 ${QR_PREVIEW_SIZE} ${QR_PREVIEW_SIZE}`}
      shapeRendering="crispEdges"
    >
      <path d={QR_PREVIEW_PATH} fill="currentColor" />
    </svg>
  )
}

function WatermarkXIcon() {
  return (
    <svg
      className="watermark-preview-x-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path d={X_LOGO_PATH} fill="currentColor" />
    </svg>
  )
}

function watermarkOpacityPercent(value: number): number {
  return Math.round(value * 100)
}

function watermarkTimingValid(
  startSeconds: number,
  endSeconds: number | null,
  duration: number,
): boolean {
  return endSeconds !== null
    ? endSeconds > startSeconds
    : duration <= 0 || startSeconds < duration
}

function watermarkVisibleAt(
  currentTime: number,
  startSeconds: number,
  endSeconds: number | null,
): boolean {
  return currentTime >= startSeconds
    && (endSeconds === null || currentTime <= endSeconds)
}

function watermarkTimelineWindow(
  startSeconds: number,
  endSeconds: number | null,
  duration: number,
): { left: number; width: number } {
  if (duration <= 0) return { left: 0, width: 100 }
  const left = clamp((startSeconds / duration) * 100, 0, 100)
  const right = clamp(((endSeconds ?? duration) / duration) * 100, left, 100)
  return { left, width: right - left }
}

function watermarkTimingLabel(
  startSeconds: number,
  endSeconds: number | null,
  duration: number,
): string {
  const end = endSeconds ?? (duration > 0 ? duration : null)
  return `${secondsLabel(startSeconds)}–${end === null ? 'clip end' : secondsLabel(end)}`
}

function WatermarkOpacityControl({
  id,
  label,
  value,
  busy,
  onChange,
}: {
  id: string
  label: string
  value: number
  busy: boolean
  onChange: (value: number) => void
}) {
  const percent = watermarkOpacityPercent(value)
  return (
    <div className="watermark-range-setting">
      <label htmlFor={id}>{label}</label>
      <output htmlFor={id}>{percent}%</output>
      <input
        id={id}
        type="range"
        min={MIN_WATERMARK_OPACITY * 100}
        max={MAX_WATERMARK_OPACITY * 100}
        step="1"
        value={percent}
        disabled={busy}
        onChange={(event) => onChange(Number(event.target.value) / 100)}
      />
    </div>
  )
}

function WatermarkTimingControl({
  idPrefix,
  label,
  startSeconds,
  endSeconds,
  duration,
  currentTime,
  busy,
  onChange,
}: {
  idPrefix: string
  label: string
  startSeconds: number
  endSeconds: number | null
  duration: number
  currentTime: number
  busy: boolean
  onChange: (startSeconds: number, endSeconds: number | null) => void
}) {
  const valid = watermarkTimingValid(startSeconds, endSeconds, duration)
  return (
    <div className="watermark-timing-group">
      <div className="watermark-timing-heading">
        <strong>{label}</strong>
        <button
          type="button"
          aria-label={`Use whole clip for ${label}`}
          disabled={busy}
          onClick={() => onChange(0, null)}
        >
          Whole clip
        </button>
      </div>
      <div className="watermark-time-fields">
        <label htmlFor={`${idPrefix}-start`}>
          Start
          <input
            id={`${idPrefix}-start`}
            aria-label={`${label} start`}
            type="number"
            min="0"
            max={duration > 0 ? duration : undefined}
            step="0.1"
            value={startSeconds}
            disabled={busy}
            onChange={(event) => onChange(
              Math.max(0, Number(event.target.value) || 0),
              endSeconds,
            )}
          />
          <button
            type="button"
            aria-label={`Set ${label} start from playhead`}
            disabled={busy}
            onClick={() => onChange(
              endSeconds === null
                ? currentTime
                : Math.min(currentTime, Math.max(0, endSeconds - 0.1)),
              endSeconds,
            )}
          >
            Set from playhead
          </button>
        </label>
        <label htmlFor={`${idPrefix}-end`}>
          End
          <input
            id={`${idPrefix}-end`}
            aria-label={`${label} end`}
            type="number"
            min="0"
            max={duration > 0 ? duration : undefined}
            step="0.1"
            value={endSeconds ?? ''}
            placeholder={duration > 0 ? duration.toFixed(1) : 'Clip end'}
            disabled={busy}
            onChange={(event) => onChange(
              startSeconds,
              event.target.value === ''
                ? null
                : Math.max(0, Number(event.target.value) || 0),
            )}
          />
          <button
            type="button"
            aria-label={`Set ${label} end from playhead`}
            disabled={busy}
            onClick={() => onChange(
              startSeconds,
              Math.max(currentTime, startSeconds + 0.1),
            )}
          >
            Set from playhead
          </button>
        </label>
      </div>
      {!valid && (
        <p className="watermark-error" role="alert">{label} end time must be after start time.</p>
      )}
    </div>
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function secondsLabel(value: number): string {
  if (!Number.isFinite(value)) return '0.0s'
  return `${value.toFixed(1)}s`
}

function previewQrStyle(
  position: Exclude<WatermarkPosition, 'auto'>,
  width: number,
  height: number,
): CSSProperties {
  const [vertical, horizontal] = position.split('-')
  const transforms: string[] = []
  const style: CSSProperties = {
    aspectRatio: '1 / 1',
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

function previewHandleStyle(
  width: number,
  height: number,
  verticalPercent: number,
): CSSProperties {
  return {
    aspectRatio: '480 / 88',
    height: `${16 * (Math.min(width, height) / height)}%`,
    top: `${verticalPercent}%`,
    left: '50%',
    transform: 'translate(-50%, -50%)',
  }
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
  const qrTimingValid = watermarkTimingValid(
    state.qrStartSeconds,
    state.qrEndSeconds,
    duration,
  )
  const handleTimingValid = watermarkTimingValid(
    state.handleStartSeconds,
    state.handleEndSeconds,
    duration,
  )
  const timingValid = handleTimingValid && (!state.includeQr || qrTimingValid)
  const qrVisibleAtPlayhead = watermarkVisibleAt(
    currentTime,
    state.qrStartSeconds,
    state.qrEndSeconds,
  )
  const handleVisibleAtPlayhead = watermarkVisibleAt(
    currentTime,
    state.handleStartSeconds,
    state.handleEndSeconds,
  )
  const previewPosition = state.position === 'auto' ? 'bottom-right' : state.position
  const previewWidth = state.width !== null && state.width > 0 ? state.width : 16
  const previewHeight = state.height !== null && state.height > 0 ? state.height : 9
  const tallPreview = previewHeight >= previewWidth
  const qrTimeline = watermarkTimelineWindow(
    state.qrStartSeconds,
    state.qrEndSeconds,
    duration,
  )
  const handleTimeline = watermarkTimelineWindow(
    state.handleStartSeconds,
    state.handleEndSeconds,
    duration,
  )
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
            {state.includeQr && (
              <span
                className="watermark-preview-overlay watermark-preview-qr"
                style={{
                  ...previewQrStyle(previewPosition, previewWidth, previewHeight),
                  opacity: qrVisibleAtPlayhead ? state.qrOpacity : 0,
                }}
                aria-hidden="true"
              >
                <WatermarkQrPreview />
              </span>
            )}
            <span
              className={`watermark-preview-overlay watermark-preview-handle${state.includeHandleBorder ? '' : ' without-border'}`}
              style={{
                ...previewHandleStyle(
                  previewWidth,
                  previewHeight,
                  state.handleVerticalPercent,
                ),
                opacity: handleVisibleAtPlayhead ? state.handleOpacity : 0,
              }}
              aria-hidden="true"
            >
              {state.includeXIcon && <WatermarkXIcon />}
              <span>{handle || 'handle'}</span>
            </span>
            {state.includeQr && state.position === 'auto' && (
              <span className="watermark-auto-preview">AUTO · QR previewing bottom right</span>
            )}
          </div>
          <div className="watermark-timeline-stack">
            {state.includeQr && (
              <div className="watermark-timeline-row">
                <span>QR</span>
                <div className="watermark-timeline" aria-label="QR visibility timeline">
                  <span
                    className="watermark-timeline-window"
                    style={{ left: `${qrTimeline.left}%`, width: `${qrTimeline.width}%` }}
                  />
                  <span
                    className="watermark-timeline-playhead"
                    style={{ left: `${playhead}%` }}
                  />
                </div>
              </div>
            )}
            <div className="watermark-timeline-row">
              <span>Handle</span>
              <div className="watermark-timeline" aria-label="Handle visibility timeline">
                <span
                  className="watermark-timeline-window"
                  style={{ left: `${handleTimeline.left}%`, width: `${handleTimeline.width}%` }}
                />
                <span
                  className="watermark-timeline-playhead"
                  style={{ left: `${playhead}%` }}
                />
              </div>
            </div>
          </div>
          <div className="watermark-preview-readout">
            <span>{state.includeQr
              ? state.position === 'auto'
                ? 'QR auto placement'
                : `QR ${POSITION_LABELS[state.position].toLowerCase()}`
              : 'Handle centered'}</span>
            <span>Handle {state.handleVerticalPercent}% from top</span>
            {state.includeQr && (
              <span>
                QR {watermarkOpacityPercent(state.qrOpacity)}% · {watermarkTimingLabel(
                  state.qrStartSeconds,
                  state.qrEndSeconds,
                  duration,
                )}
              </span>
            )}
            <span>
              Handle {watermarkOpacityPercent(state.handleOpacity)}% · {watermarkTimingLabel(
                state.handleStartSeconds,
                state.handleEndSeconds,
                duration,
              )}
            </span>
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
                <small>Add a separately placed scannable link</small>
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
            <span className="watermark-section-label">Appearance</span>
            <label className="watermark-toggle">
              <span>
                <strong>Show X icon</strong>
                <small>Place the X mark before the plain handle</small>
              </span>
              <input
                type="checkbox"
                checked={state.includeXIcon}
                disabled={busy}
                onChange={(event) => onChange({ includeXIcon: event.target.checked })}
              />
            </label>
            <label className="watermark-toggle">
              <span>
                <strong>Handle border</strong>
                <small>Draw the outline around the handle pill</small>
              </span>
              <input
                type="checkbox"
                checked={state.includeHandleBorder}
                disabled={busy}
                onChange={(event) => onChange({ includeHandleBorder: event.target.checked })}
              />
            </label>
            {state.includeQr && (
              <WatermarkOpacityControl
                id="watermark-qr-opacity"
                label="QR opacity"
                value={state.qrOpacity}
                busy={busy}
                onChange={(qrOpacity) => onChange({ qrOpacity })}
              />
            )}
            <WatermarkOpacityControl
              id="watermark-handle-opacity"
              label="Handle opacity"
              value={state.handleOpacity}
              busy={busy}
              onChange={(handleOpacity) => onChange({ handleOpacity })}
            />
          </section>

          <section className="watermark-control-section">
            <div className="watermark-section-heading">
              <span>Position</span>
              <button
                type="button"
                className={state.position === 'auto' ? 'active' : ''}
                aria-pressed={state.position === 'auto'}
                disabled={busy || !state.includeQr}
                onClick={() => onChange({ position: 'auto' })}
              >
                Auto
              </button>
            </div>
            <div className="watermark-position-grid" role="group" aria-label="QR position">
              {WATERMARK_POSITIONS.map((position) => (
                <button
                  key={position}
                  type="button"
                  className={state.position === position ? 'active' : ''}
                  aria-label={POSITION_LABELS[position]}
                  aria-pressed={state.position === position}
                  title={POSITION_LABELS[position]}
                  disabled={busy || !state.includeQr}
                  onClick={() => onChange({ position })}
                >
                  <span />
                </button>
              ))}
            </div>
            <div className="watermark-handle-position">
              <label htmlFor="watermark-handle-vertical">Handle vertical position</label>
              <output htmlFor="watermark-handle-vertical">
                {state.handleVerticalPercent}% from top
              </output>
              <input
                id="watermark-handle-vertical"
                type="range"
                min={MIN_HANDLE_VERTICAL_PERCENT}
                max={MAX_HANDLE_VERTICAL_PERCENT}
                step="1"
                value={state.handleVerticalPercent}
                disabled={busy}
                onChange={(event) => onChange({
                  handleVerticalPercent: Number(event.target.value),
                })}
              />
            </div>
            <small className="watermark-control-help">
              Auto places the QR away from faces and text. The handle remains horizontally centered.
            </small>
          </section>

          <section className="watermark-control-section">
            <span className="watermark-section-label">Timing</span>
            <div className="watermark-timing-groups">
              {state.includeQr && (
                <WatermarkTimingControl
                  idPrefix="watermark-qr-timing"
                  label="QR"
                  startSeconds={state.qrStartSeconds}
                  endSeconds={state.qrEndSeconds}
                  duration={duration}
                  currentTime={currentTime}
                  busy={busy}
                  onChange={(qrStartSeconds, qrEndSeconds) => onChange({
                    qrStartSeconds,
                    qrEndSeconds,
                  })}
                />
              )}
              <WatermarkTimingControl
                idPrefix="watermark-handle-timing"
                label="Handle"
                startSeconds={state.handleStartSeconds}
                endSeconds={state.handleEndSeconds}
                duration={duration}
                currentTime={currentTime}
                busy={busy}
                onChange={(handleStartSeconds, handleEndSeconds) => onChange({
                  handleStartSeconds,
                  handleEndSeconds,
                })}
              />
            </div>
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

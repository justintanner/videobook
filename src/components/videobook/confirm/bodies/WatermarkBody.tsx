import { useState } from 'react'
import { WATERMARK_LOGO_PATHS, WATERMARK_PLATFORM_LABELS, WATERMARK_PLATFORMS, isWatermarkPlatform, watermarkProfileUrl } from '../../../../../server/src/watermark-platform'
import type { WatermarkPlatform } from '../../../../../server/src/watermark-platform'
import type { CSSProperties } from 'react'
import { Play } from 'lucide-react'
import {
  DEFAULT_HANDLE_PILL_HEIGHT,
  HANDLE_BADGE_WIDTH,
  handlePillHeight,
  MAX_HANDLE_PADDING,
  MAX_HANDLE_ROUNDING,
  MAX_HANDLE_VERTICAL_PERCENT,
  MAX_WATERMARK_FADE_SECONDS,
  MAX_WATERMARK_OPACITY,
  MIN_HANDLE_PADDING,
  MIN_HANDLE_ROUNDING,
  MIN_HANDLE_VERTICAL_PERCENT,
  MIN_WATERMARK_FADE_SECONDS,
  MIN_WATERMARK_OPACITY,
  WATERMARK_HANDLE_PLACEMENTS,
  WATERMARK_POSITIONS,
  watermarkPreviewOpacity,
} from '@/videobook/watermark-review'
import type {
  WatermarkHandlePlacement,
  WatermarkPosition,
} from '@/videobook/watermark-review'
import {
  watermarkHandleValue,
  watermarkTimingValid,
} from '@/videobook/confirm-validation'

export interface WatermarkReviewState {
  assetId: string
  targetLabel: string
  mediaUrl: string | null
  thumbnailUrl: string | null
  width: number | null
  height: number | null
  durationSeconds: number | null
  platform: WatermarkPlatform
  identities: Record<WatermarkPlatform, { handle: string; recent: string[] }>
  url: string
  includeQr: boolean
  includeHandle: boolean
  position: WatermarkPosition
  handleVerticalPercent: number
  handlePlacement: WatermarkHandlePlacement
  includePlatformIcon: boolean
  includeHandleBorder: boolean
  handlePadding: number
  handlePaddingY: number
  handleRounding: number
  qrOpacity: number
  handleOpacity: number
  qrStartSeconds: number
  qrEndSeconds: number | null
  handleStartSeconds: number
  handleEndSeconds: number | null
  fadeSeconds: number
  saveDefault: boolean
  loadingConfig: boolean
  error: string | null
}

type WatermarkReviewPatch = Partial<Pick<WatermarkReviewState,
  | 'platform'
  | 'url'
  | 'includeQr'
  | 'includeHandle'
  | 'position'
  | 'handleVerticalPercent'
  | 'handlePlacement'
  | 'includePlatformIcon'
  | 'includeHandleBorder'
  | 'handlePadding'
  | 'handlePaddingY'
  | 'handleRounding'
  | 'qrOpacity'
  | 'handleOpacity'
  | 'qrStartSeconds'
  | 'qrEndSeconds'
  | 'handleStartSeconds'
  | 'handleEndSeconds'
  | 'fadeSeconds'
  | 'saveDefault'
>> & { handle?: string }

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
const HANDLE_FONT_SIZE = 28
const QR_PREVIEW_SIZE_PERCENT = 16
const HANDLE_PLACEMENT_LABELS: Record<WatermarkHandlePlacement, string> = {
  center: 'Centered',
  'above-qr': 'Above QR',
  'on-qr': 'On QR',
  'below-qr': 'Below QR',
}

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

function WatermarkPlatformIcon({ platform }: { platform: WatermarkPlatform }) {
  return (
    <svg
      className={`watermark-preview-platform-icon watermark-preview-${platform}-icon`}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path d={WATERMARK_LOGO_PATHS[platform]} fill="currentColor" />
    </svg>
  )
}

function watermarkOpacityPercent(value: number): number {
  return Math.round(value * 100)
}

function fadeLabel(fadeSeconds: number): string {
  return fadeSeconds > 0 ? `${fadeSeconds.toFixed(1)}s` : 'Off'
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function secondsLabel(value: number): string {
  if (!Number.isFinite(value)) return '0.0s'
  return `${value.toFixed(1)}s`
}

function previewQrSize(width: number, height: number): number {
  return QR_PREVIEW_SIZE_PERCENT * (Math.min(width, height) / height)
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
    height: `${previewQrSize(width, height)}%`,
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
  paddingY: number,
  placement: WatermarkHandlePlacement,
  qrPosition: Exclude<WatermarkPosition, 'auto'>,
): CSSProperties {
  const pillHeight = handlePillHeight(paddingY)
  if (placement === 'center') {
    return {
      aspectRatio: `${HANDLE_BADGE_WIDTH} / ${pillHeight}`,
      height: `${previewQrSize(width, height) * (pillHeight / DEFAULT_HANDLE_PILL_HEIGHT)}%`,
      top: `${verticalPercent}%`,
      left: '50%',
      transform: 'translate(-50%, -50%)',
    }
  }
  const [vertical, horizontal] = qrPosition.split('-')
  const qrHeightPercent = previewQrSize(width, height)
  const qrWidthPercent = qrHeightPercent * (height / width)
  const handleHeightPercent = qrHeightPercent * (pillHeight / HANDLE_BADGE_WIDTH)
  const verticalInset = 2 * (width / height)
  const gapPercent = Math.max(0.4, qrHeightPercent * 0.06)
  let left = horizontal === 'left'
    ? 2
    : horizontal === 'right'
      ? 100 - 2 - qrWidthPercent
      : 50 - qrWidthPercent / 2
  const qrTop = vertical === 'top'
    ? verticalInset
    : vertical === 'bottom'
      ? 100 - verticalInset - qrHeightPercent
      : 50 - qrHeightPercent / 2
  let top = placement === 'above-qr'
    ? qrTop - handleHeightPercent - gapPercent
    : placement === 'below-qr'
      ? qrTop + qrHeightPercent + gapPercent
      : qrTop + (qrHeightPercent - handleHeightPercent) / 2
  left = clamp(left, 2, 100 - 2 - qrWidthPercent)
  top = clamp(top, verticalInset, 100 - verticalInset - handleHeightPercent)
  return {
    aspectRatio: `${HANDLE_BADGE_WIDTH} / ${pillHeight}`,
    width: `${qrWidthPercent}%`,
    height: 'auto',
    top: `${top}%`,
    left: `${left}%`,
  }
}

function previewHandlePillStyle(
  paddingX: number,
  paddingY: number,
  rounding: number,
): CSSProperties {
  const radius = ((handlePillHeight(paddingY) - 2) / 2) * (rounding / 100)
  return {
    paddingInline: `${paddingX / HANDLE_FONT_SIZE}em`,
    borderRadius: `${radius / HANDLE_FONT_SIZE}em`,
  }
}

function WatermarkToggle({
  busy,
  checked,
  description,
  disabled = false,
  label,
  onChange,
}: {
  busy: boolean
  checked: boolean
  description: string
  disabled?: boolean
  label: string
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="confirm-toggle">
      <input
        type="checkbox"
        checked={checked}
        disabled={busy || disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="confirm-toggle-copy">
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
    </label>
  )
}

function WatermarkRange({
  busy,
  id,
  label,
  max,
  min,
  onChange,
  output,
  value,
}: {
  busy: boolean
  id: string
  label: string
  max: number
  min: number
  onChange: (value: number) => void
  output: string
  value: number
}) {
  return (
    <div className="confirm-range">
      <label htmlFor={id}>{label}</label>
      <output htmlFor={id}>{output}</output>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step="1"
        value={value}
        disabled={busy}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  )
}

function WatermarkTimingRow({
  busy,
  currentTime,
  duration,
  endSeconds,
  idPrefix,
  label,
  onChange,
  playhead,
  startSeconds,
}: {
  busy: boolean
  currentTime: number
  duration: number
  endSeconds: number | null
  idPrefix: string
  label: string
  onChange: (startSeconds: number, endSeconds: number | null) => void
  playhead: number
  startSeconds: number
}) {
  const valid = watermarkTimingValid(startSeconds, endSeconds, duration)
  const window = watermarkTimelineWindow(startSeconds, endSeconds, duration)
  return (
    <div className="confirm-watermark-timing" role="group" aria-label={`${label} timing`}>
      <div className="confirm-watermark-timing-row">
        <span>{label}</span>
        <div className="watermark-timeline" aria-hidden="true">
          <span
            className="watermark-timeline-window"
            style={{ left: `${window.left}%`, width: `${window.width}%` }}
          />
          <span
            className="watermark-timeline-playhead"
            style={{ left: `${playhead}%` }}
          />
        </div>
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
        <span className="confirm-watermark-timing-arrow" aria-hidden="true">→</span>
        <input
          id={`${idPrefix}-end`}
          aria-label={`${label} end`}
          aria-invalid={!valid}
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
        <div className="confirm-watermark-timing-actions">
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
            <Play size={8} aria-hidden="true" />Start
          </button>
          <button
            type="button"
            aria-label={`Set ${label} end from playhead`}
            disabled={busy}
            onClick={() => onChange(
              startSeconds,
              Math.max(currentTime, startSeconds + 0.1),
            )}
          >
            <Play size={8} aria-hidden="true" />End
          </button>
          <button
            type="button"
            aria-label={`Use whole clip for ${label}`}
            disabled={busy}
            onClick={() => onChange(0, null)}
          >
            Whole
          </button>
        </div>
      </div>
      {!valid && (
        <p className="confirm-field-error">{label} end time must be after its start time.</p>
      )}
    </div>
  )
}

export function WatermarkBody({
  busy,
  state,
  onChange,
  onMediaMetadata,
}: {
  busy: boolean
  state: WatermarkReviewState
  onChange: (patch: WatermarkReviewPatch) => void
  onMediaMetadata: (metadata: MediaMetadata) => void
}) {
  const [currentTime, setCurrentTime] = useState(0)
  const identity = state.identities[state.platform]
  const handle = watermarkHandleValue(identity.handle)
  const platformLabel = WATERMARK_PLATFORM_LABELS[state.platform]
  const urlPlaceholder = watermarkProfileUrl(handle || '<handle>', state.platform)
  const duration = state.durationSeconds ?? 0
  const handleMissing = state.includeHandle && !handle
  const linkMissing = state.includeQr && !state.url.trim() && !handle
  const qrPreviewOpacity = watermarkPreviewOpacity(
    currentTime,
    state.qrStartSeconds,
    state.qrEndSeconds,
    duration,
    state.qrOpacity,
    state.fadeSeconds,
  )
  const handlePreviewOpacity = watermarkPreviewOpacity(
    currentTime,
    state.handleStartSeconds,
    state.handleEndSeconds,
    duration,
    state.handleOpacity,
    state.fadeSeconds,
  )
  const previewPosition = state.position === 'auto' ? 'bottom-right' : state.position
  const previewWidth = state.width !== null && state.width > 0 ? state.width : 16
  const previewHeight = state.height !== null && state.height > 0 ? state.height : 9
  const tallPreview = previewHeight >= previewWidth
  const playhead = duration > 0
    ? clamp((currentTime / duration) * 100, 0, 100)
    : 0

  return (
    <div className="confirm-watermark">
      <section className="confirm-section confirm-watermark-preview" aria-label="Preview">
        <div className="confirm-section-heading">
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
                opacity: qrPreviewOpacity,
              }}
              aria-hidden="true"
            >
              <WatermarkQrPreview />
            </span>
          )}
          {state.includeHandle && (
            <span
              className="watermark-preview-overlay watermark-preview-handle"
              style={{
                ...previewHandleStyle(
                  previewWidth,
                  previewHeight,
                  state.handleVerticalPercent,
                  state.handlePaddingY,
                  state.includeQr ? state.handlePlacement : 'center',
                  previewPosition,
                ),
                opacity: handlePreviewOpacity,
              }}
              aria-hidden="true"
            >
              <span
                className={`watermark-preview-handle-pill${state.includeHandleBorder ? '' : ' without-border'}`}
                style={previewHandlePillStyle(
                  state.handlePadding,
                  state.handlePaddingY,
                  state.handleRounding,
                )}
              >
                {state.includePlatformIcon && <WatermarkPlatformIcon platform={state.platform} />}
                <span>{handle || 'handle'}</span>
              </span>
            </span>
          )}
          {state.includeQr && state.position === 'auto' && (
            <span className="watermark-auto-preview">AUTO · QR previewing bottom right</span>
          )}
        </div>
        <div className="confirm-watermark-timings">
          {state.includeQr && (
            <WatermarkTimingRow
              busy={busy}
              currentTime={currentTime}
              duration={duration}
              endSeconds={state.qrEndSeconds}
              idPrefix="watermark-qr-timing"
              label="QR"
              playhead={playhead}
              startSeconds={state.qrStartSeconds}
              onChange={(qrStartSeconds, qrEndSeconds) => onChange({
                qrStartSeconds,
                qrEndSeconds,
              })}
            />
          )}
          {state.includeHandle && (
            <WatermarkTimingRow
              busy={busy}
              currentTime={currentTime}
              duration={duration}
              endSeconds={state.handleEndSeconds}
              idPrefix="watermark-handle-timing"
              label="Handle"
              playhead={playhead}
              startSeconds={state.handleStartSeconds}
              onChange={(handleStartSeconds, handleEndSeconds) => onChange({
                handleStartSeconds,
                handleEndSeconds,
              })}
            />
          )}
        </div>
      </section>

      <div className="confirm-watermark-controls">
        <section className="confirm-section" aria-label="Identity">
          <span className="confirm-section-label">Identity</span>
          <label className="confirm-field">
            <span>Platform</span>
            <select
              value={state.platform}
              disabled={busy}
              onChange={(event) => {
                const platform = event.target.value
                if (isWatermarkPlatform(platform)) onChange({ platform })
              }}
            >
              {WATERMARK_PLATFORMS.map((platform) => (
                <option key={platform} value={platform}>{WATERMARK_PLATFORM_LABELS[platform]}</option>
              ))}
            </select>
          </label>
          <WatermarkToggle
            busy={busy}
            checked={state.includeHandle}
            description="Centered account badge"
            disabled={state.includeHandle && !state.includeQr}
            label="Include handle"
            onChange={(includeHandle) => onChange({ includeHandle })}
          />
          {state.includeHandle && (
            <>
              <label className="confirm-field">
                <span>{platformLabel} handle</span>
                <div className={`confirm-handle-field${handleMissing ? ' invalid' : ''}`}>
                  <span aria-hidden="true">@</span>
                  <input
                    type="text"
                    value={identity.handle}
                    placeholder={state.loadingConfig ? 'Loading…' : 'handle'}
                    aria-invalid={handleMissing}
                    disabled={busy}
                    onChange={(event) => onChange({ handle: event.target.value })}
                  />
                </div>
                {handleMissing && (
                  <span className="confirm-field-error">Required while Include handle is on</span>
                )}
              </label>
              {identity.recent.length > 0 && (
                <div className="confirm-chips" role="group" aria-label="Recent handles">
                  {identity.recent.map((recentHandle) => (
                    <button
                      key={recentHandle}
                      type="button"
                      className={recentHandle === handle ? 'active' : ''}
                      aria-pressed={recentHandle === handle}
                      disabled={busy}
                      onClick={() => onChange({ handle: recentHandle })}
                    >
                      @{recentHandle}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          <WatermarkToggle
            busy={busy}
            checked={state.includeQr}
            description="Separately placed scannable link"
            disabled={state.includeQr && !state.includeHandle}
            label="Include QR code"
            onChange={(includeQr) => onChange({
              includeQr,
              ...(!includeQr ? { handlePlacement: 'center' as const } : {}),
            })}
          />
          {state.includeQr && (
            <label className="confirm-field">
              <span>QR link</span>
              <input
                type="text"
                value={state.url}
                placeholder={urlPlaceholder}
                aria-invalid={linkMissing}
                disabled={busy}
                onChange={(event) => onChange({ url: event.target.value })}
              />
              {linkMissing && (
                <span className="confirm-field-error">Enter a link, or a handle it can point to</span>
              )}
            </label>
          )}
          {state.includeHandle && (
            <label className="confirm-check">
              <input
                type="checkbox"
                checked={state.saveDefault}
                disabled={busy}
                onChange={(event) => onChange({ saveDefault: event.target.checked })}
              />
              Save as default handle
            </label>
          )}
        </section>

        <section className="confirm-section" aria-label="Appearance">
          <span className="confirm-section-label">Appearance</span>
          {state.includeHandle && (
            <>
              <WatermarkToggle
                busy={busy}
                checked={state.includePlatformIcon}
                description={`${platformLabel} mark before the handle`}
                label={`Show ${platformLabel} icon`}
                onChange={(includePlatformIcon) => onChange({ includePlatformIcon })}
              />
              <WatermarkToggle
                busy={busy}
                checked={state.includeHandleBorder}
                description="Outline around the pill"
                label="Handle border"
                onChange={(includeHandleBorder) => onChange({ includeHandleBorder })}
              />
              <WatermarkRange
                busy={busy}
                id="watermark-handle-padding-x"
                label="Handle padding X"
                min={MIN_HANDLE_PADDING}
                max={MAX_HANDLE_PADDING}
                output={`${state.handlePadding}px`}
                value={state.handlePadding}
                onChange={(handlePadding) => onChange({ handlePadding })}
              />
              <WatermarkRange
                busy={busy}
                id="watermark-handle-padding-y"
                label="Handle padding Y"
                min={MIN_HANDLE_PADDING}
                max={MAX_HANDLE_PADDING}
                output={`${state.handlePaddingY}px`}
                value={state.handlePaddingY}
                onChange={(handlePaddingY) => onChange({ handlePaddingY })}
              />
              <WatermarkRange
                busy={busy}
                id="watermark-handle-rounding"
                label="Corner rounding"
                min={MIN_HANDLE_ROUNDING}
                max={MAX_HANDLE_ROUNDING}
                output={`${state.handleRounding}%`}
                value={state.handleRounding}
                onChange={(handleRounding) => onChange({ handleRounding })}
              />
            </>
          )}
          {state.includeQr && (
            <WatermarkRange
              busy={busy}
              id="watermark-qr-opacity"
              label="QR opacity"
              min={MIN_WATERMARK_OPACITY * 100}
              max={MAX_WATERMARK_OPACITY * 100}
              output={`${watermarkOpacityPercent(state.qrOpacity)}%`}
              value={watermarkOpacityPercent(state.qrOpacity)}
              onChange={(percent) => onChange({ qrOpacity: percent / 100 })}
            />
          )}
          {state.includeHandle && (
            <WatermarkRange
              busy={busy}
              id="watermark-handle-opacity"
              label="Handle opacity"
              min={MIN_WATERMARK_OPACITY * 100}
              max={MAX_WATERMARK_OPACITY * 100}
              output={`${watermarkOpacityPercent(state.handleOpacity)}%`}
              value={watermarkOpacityPercent(state.handleOpacity)}
              onChange={(percent) => onChange({ handleOpacity: percent / 100 })}
            />
          )}
          <WatermarkRange
            busy={busy}
            id="watermark-fade"
            label="Fade in/out"
            min={MIN_WATERMARK_FADE_SECONDS * 10}
            max={MAX_WATERMARK_FADE_SECONDS * 10}
            output={fadeLabel(state.fadeSeconds)}
            value={Math.round(state.fadeSeconds * 10)}
            onChange={(tenths) => onChange({ fadeSeconds: tenths / 10 })}
          />
          <small className="confirm-help">
            Fades only where a watermark starts or ends inside the clip.
          </small>
        </section>

        <section className="confirm-section confirm-watermark-position" aria-label="Position">
          <span className="confirm-section-label">Position</span>
          <div className="confirm-watermark-qr-position">
            <div className="confirm-watermark-qr-position-heading">
              <span>QR position</span>
              <button
                type="button"
                className={`confirm-chip${state.position === 'auto' ? ' active' : ''}`}
                aria-pressed={state.position === 'auto'}
                disabled={busy || !state.includeQr}
                onClick={() => onChange({ position: 'auto' })}
              >
                Auto
              </button>
            </div>
            <div className="confirm-position-grid" role="group" aria-label="QR position">
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
          </div>
          <div className="confirm-watermark-handle-position">
            {state.includeHandle && (
              <>
                <div className="confirm-watermark-handle-placement">
                  <span>Handle placement</span>
                  <div className="confirm-chips" role="group" aria-label="Handle placement">
                    {WATERMARK_HANDLE_PLACEMENTS.map((placement) => {
                      const attached = placement !== 'center'
                      const disabled = busy || (attached && !state.includeQr)
                      return (
                        <button
                          key={placement}
                          type="button"
                          className={state.handlePlacement === placement ? 'active' : ''}
                          aria-pressed={state.handlePlacement === placement}
                          disabled={disabled}
                          onClick={() => onChange({ handlePlacement: placement })}
                        >
                          {HANDLE_PLACEMENT_LABELS[placement]}
                        </button>
                      )
                    })}
                  </div>
                </div>
                {state.handlePlacement === 'center' && (
                  <WatermarkRange
                    busy={busy}
                    id="watermark-handle-vertical"
                    label="Handle vertical position"
                    min={MIN_HANDLE_VERTICAL_PERCENT}
                    max={MAX_HANDLE_VERTICAL_PERCENT}
                    output={`${state.handleVerticalPercent}% from top`}
                    value={state.handleVerticalPercent}
                    onChange={(handleVerticalPercent) => onChange({ handleVerticalPercent })}
                  />
                )}
              </>
            )}
            <small className="confirm-help">
              {state.includeQr && state.includeHandle
                ? state.handlePlacement === 'center'
                  ? 'Auto places the QR away from faces and text. The handle stays horizontally centered.'
                  : 'Auto places the QR away from faces and text. The handle sits with the QR.'
                : state.includeQr
                  ? 'Auto places the QR away from faces and text.'
                  : 'The handle stays horizontally centered.'}
            </small>
          </div>
        </section>
      </div>
    </div>
  )
}

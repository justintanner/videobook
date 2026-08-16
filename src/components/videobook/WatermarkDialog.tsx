import { useRef } from 'react'
import { X } from 'lucide-react'
import {
  handleModalDialogKeyDown,
  shouldDismissModalDialogFromBackdrop,
} from '@/videobook/modal-dialog-interactions'

export interface WatermarkDialogState {
  assetId: string
  targetLabel: string
  handle: string
  url: string
  saveDefault: boolean
  recent: string[]
  loadingConfig: boolean
  submitting: boolean
  error: string | null
}

export function WatermarkDialog({
  state,
  onHandle,
  onUrl,
  onSaveDefault,
  onSubmit,
  onClose,
}: {
  state: WatermarkDialogState
  onHandle: (value: string) => void
  onUrl: (value: string) => void
  onSaveDefault: (value: boolean) => void
  onSubmit: () => void
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLElement | null>(null)
  const busy = state.submitting
  const handle = state.handle.replace(/^@/, '').trim()
  const urlPlaceholder = handle ? `https://x.com/${handle}` : 'https://x.com/<handle>'

  return (
    <div
      className="watermark-backdrop"
      onMouseDown={(event) => {
        if (shouldDismissModalDialogFromBackdrop(
          event.currentTarget,
          event.target,
          busy,
        )) onClose()
      }}
    >
      <section
        ref={dialogRef}
        className="watermark-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="watermark-title"
        aria-describedby="watermark-description"
        onKeyDown={(event) => handleModalDialogKeyDown(event, {
          busy,
          container: dialogRef.current,
          onClose,
        })}
      >
        <header>
          <div>
            <span>{state.targetLabel.toUpperCase()}</span>
            <h2 id="watermark-title">Watermark video</h2>
            <p id="watermark-description">
              Burns a faint QR + handle badge into the clip, auto-placed in the least-busy corner.
            </p>
          </div>
          <button
            type="button"
            className="watermark-close"
            aria-label="Close watermark dialog"
            disabled={busy}
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>
        <form
          className="watermark-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (!busy && handle) onSubmit()
          }}
        >
          <label>
            X handle
            <div className="watermark-handle-field">
              <span aria-hidden="true">@</span>
              <input
                type="text"
                value={state.handle}
                placeholder={state.loadingConfig ? 'Loading…' : 'handle'}
                disabled={busy}
                autoFocus
                onChange={(event) => onHandle(event.target.value)}
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
                  onClick={() => onHandle(recentHandle)}
                >
                  @{recentHandle}
                </button>
              ))}
            </div>
          )}
          <label>
            QR link
            <input
              type="text"
              value={state.url}
              placeholder={urlPlaceholder}
              disabled={busy}
              onChange={(event) => onUrl(event.target.value)}
            />
          </label>
          <label className="watermark-save-default">
            <input
              type="checkbox"
              checked={state.saveDefault}
              disabled={busy}
              onChange={(event) => onSaveDefault(event.target.checked)}
            />
            Save as default handle
          </label>
          {state.error && <p className="watermark-error" role="alert">{state.error}</p>}
          <footer>
            <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="submit" disabled={busy || !handle}>
              {state.submitting ? 'Applying…' : 'Apply watermark'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  )
}

import type { ReactNode } from 'react'
import { Ban, CircleAlert, TriangleAlert, X } from 'lucide-react'
import type { ConfirmSheetStatus } from '@/videobook/confirm-validation'
import {
  ConfirmSheetEffectChip,
  ConfirmSheetReadyHints,
  type ConfirmSheetEffect,
} from './ConfirmSheetHints'

export type { ConfirmSheetEffect }

function StatusIcon({ state }: { state: ConfirmSheetStatus['state'] }) {
  if (state === 'blocking') return <Ban size={14} aria-hidden="true" />
  if (state === 'failed') return <CircleAlert size={14} aria-hidden="true" />
  if (state === 'notice') return <TriangleAlert size={14} aria-hidden="true" />
  if (state === 'busy') {
    return (
      <span className="confirm-sheet-signal" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    )
  }
  return null
}

// Why Apply is or isn't available, and what it will do. Apply and Cancel live
// in the header; this row carries the reading, plus whatever the sheet offers
// besides those two decisions. A ready sheet has no reading to give, so the
// header takes the hints and this row is not drawn at all.
export function ConfirmSheetFooter({
  effect,
  hints,
  onDismissStatus,
  secondaryActions,
  status,
  statusId,
}: {
  effect: ConfirmSheetEffect | null
  hints: ReactNode
  onDismissStatus: () => void
  secondaryActions: ReactNode
  status: ConfirmSheetStatus
  statusId: string
}) {
  const alert = status.state === 'blocking' || status.state === 'failed'
  return (
    <footer className={`confirm-sheet-foot confirm-sheet-foot-${status.state}`}>
      <div
        id={statusId}
        className={`confirm-sheet-status confirm-sheet-status-${status.state}`}
        role={alert ? 'alert' : 'status'}
        aria-live={alert ? 'assertive' : 'polite'}
      >
        <StatusIcon state={status.state} />
        {status.state === 'ready'
          ? hints ?? <ConfirmSheetReadyHints />
          : (
              <span>
                {status.state === 'blocking' && <strong>Can’t apply — </strong>}
                {status.state === 'failed' && <strong>Apply failed — </strong>}
                {status.message}
              </span>
            )}
        {status.dismissible && (
          <button
            type="button"
            className="confirm-sheet-status-dismiss"
            aria-label="Dismiss message"
            onClick={onDismissStatus}
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      {(secondaryActions || effect) && (
        <div className="confirm-sheet-aside">
          {secondaryActions}
          {effect && <ConfirmSheetEffectChip effect={effect} />}
        </div>
      )}
    </footer>
  )
}

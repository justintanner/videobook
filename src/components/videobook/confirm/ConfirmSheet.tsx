import { Suspense, useContext, useId, useState, type ReactNode } from 'react'
import { ComposerOutcomeContext } from '@/components/videobook/composer-outcome-context'
import {
  confirmSheetStatus,
  type ConfirmValidation,
} from '@/videobook/confirm-validation'
import { ConfirmSheetFooter } from './ConfirmSheetFooter'
import { ConfirmSheetHeader, type ConfirmSheetEffect } from './ConfirmSheetHeader'
import { ConfirmSheetInitialFocus, useConfirmSheetKeys } from './useConfirmSheetKeys'

interface ConfirmSheetProps {
  address?: string | null
  applyFormId: string
  // Stable accessible name for the dialog ("Watermark review"); the visible
  // title is the sheet's first heading and changes with the draft.
  ariaLabel: string
  applyLabel?: string
  busy: boolean
  busyLabel?: string
  children: ReactNode
  effect?: ConfirmSheetEffect | null
  hints?: ReactNode
  kind: string
  onCancel: () => void
  secondaryActions?: ReactNode
  tag: string
  title: string
  validation: ConfirmValidation
}

// The one shell every pending action renders through: identity strip, body,
// and a footer whose single status slot explains why Apply is or isn't
// available. Composer outcomes (a failed apply, an info line) land in that
// slot while the sheet is open.
export function ConfirmSheet({
  address = null,
  applyFormId,
  applyLabel = 'Apply',
  ariaLabel,
  busy,
  busyLabel = 'Applying…',
  children,
  effect = null,
  hints = null,
  kind,
  onCancel,
  secondaryActions = null,
  tag,
  title,
  validation,
}: ConfirmSheetProps) {
  const id = useId()
  const titleId = `${id}-title`
  const statusId = `${id}-status`
  const composer = useContext(ComposerOutcomeContext)
  // Messages that predate this sheet belong to whatever came before it.
  const [staleOutcome] = useState(() => composer?.outcome ?? null)
  const [staleNotice] = useState(() => composer?.notice ?? null)
  const outcome = composer && composer.outcome !== staleOutcome ? composer.outcome : null
  const notice = composer && composer.notice !== staleNotice ? composer.notice : null
  const status = confirmSheetStatus({ busy, busyLabel, validation, outcome, notice })
  const applyDisabled = validation.blocking !== null
  const { sheetRef, onKeyDown } = useConfirmSheetKeys({
    applyFormId,
    applyDisabled,
    busy,
    onCancel,
  })

  const dismissStatus = () => {
    if (outcome) composer?.dismissOutcome()
    else if (notice) composer?.dismissNotice()
  }

  return (
    <aside
      ref={sheetRef}
      className={`confirm-sheet confirm-sheet-${kind}`}
      role="dialog"
      aria-label={ariaLabel}
      aria-describedby={statusId}
      aria-keyshortcuts="Escape Meta+Enter Control+Enter"
      onKeyDown={onKeyDown}
    >
      <ConfirmSheetHeader
        address={address}
        effect={effect}
        tag={tag}
        title={title}
        titleId={titleId}
      />
      <div className="confirm-sheet-body">
        <Suspense fallback={null}>
          {children}
          <ConfirmSheetInitialFocus sheetRef={sheetRef} />
        </Suspense>
      </div>
      <ConfirmSheetFooter
        applyDisabled={applyDisabled}
        applyFormId={applyFormId}
        applyLabel={applyLabel}
        busy={busy}
        hints={hints}
        onCancel={onCancel}
        onDismissStatus={dismissStatus}
        secondaryActions={secondaryActions}
        status={status}
        statusId={statusId}
      />
    </aside>
  )
}

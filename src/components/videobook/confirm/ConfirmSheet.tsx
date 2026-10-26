import { Suspense, useContext, useId, useState, type CSSProperties, type ReactNode } from 'react'
import { PaneResizeHandle } from '../PaneResizeHandle'
import { ComposerOutcomeContext } from '@/components/videobook/composer-outcome-context'
import {
  confirmSheetStatus,
  type ConfirmValidation,
} from '@/videobook/confirm-validation'
import {
  confirmSheetHintsInHeader,
} from '@/videobook/confirm-sheet-chrome'
import { ConfirmSheetActions } from './ConfirmSheetActions'
import { ConfirmSheetFooter } from './ConfirmSheetFooter'
import { ConfirmSheetHeader } from './ConfirmSheetHeader'
import { ConfirmSheetReadyHints, type ConfirmSheetEffect } from './ConfirmSheetHints'
import { useConfirmSheetWideChrome } from './useConfirmSheetChrome'
import { ConfirmSheetInitialFocus, useConfirmSheetKeys } from './useConfirmSheetKeys'

interface ConfirmSheetProps {
  address?: string | null
  applyFormId: string
  // Stable accessible name for the dialog ("Watermark review"); the visible
  // title is the sheet's first heading and changes with the draft.
  ariaLabel: string
  applyLabel?: string
  busy: boolean
  cancelLabel?: string
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

// The one shell every pending action renders through: an identity strip that
// carries Apply and Cancel, the body, and a footer whose single status slot
// explains why Apply is or isn't available and what it will do. Composer
// outcomes (a failed apply, an info line) land in that slot while the sheet
// is open.
export function ConfirmSheet({
  address = null,
  applyFormId,
  applyLabel = 'Apply',
  ariaLabel,
  busy,
  busyLabel = 'Applying…',
  cancelLabel = 'Cancel',
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
  const [reviewHeight, setReviewHeight] = useState<number | null>(null)
  // Messages that predate this sheet belong to whatever came before it.
  const [staleOutcome] = useState(() => composer?.outcome ?? null)
  const [staleNotice] = useState(() => composer?.notice ?? null)
  const outcome = composer && composer.outcome !== staleOutcome ? composer.outcome : null
  const notice = composer && composer.notice !== staleNotice ? composer.notice : null
  const status = confirmSheetStatus({ busy, busyLabel, validation, outcome, notice })
  const wideEnough = useConfirmSheetWideChrome()
  const hintsInHeader = confirmSheetHintsInHeader({
    state: status.state,
    hasSecondaryActions: Boolean(secondaryActions),
    wideEnough,
  })
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
      style={reviewHeight === null ? undefined : { '--confirm-review-height': `${reviewHeight}px` } as CSSProperties}
      role="dialog"
      aria-label={ariaLabel}
      aria-describedby={statusId}
      aria-keyshortcuts="Escape Meta+Enter Control+Enter"
      onKeyDown={onKeyDown}
    >
      <ConfirmSheetHeader
        actions={(
          <ConfirmSheetActions
            applyDisabled={applyDisabled}
            applyFormId={applyFormId}
            applyLabel={applyLabel}
            busy={busy}
            busyLabel={status.message ?? busyLabel}
            cancelLabel={cancelLabel}
            failed={status.state === 'failed'}
            onCancel={onCancel}
          />
        )}
        address={address}
        effect={effect}
        hints={hintsInHeader ? hints ?? <ConfirmSheetReadyHints /> : null}
        hintsId={hintsInHeader ? statusId : undefined}
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
      {!hintsInHeader && (
        <ConfirmSheetFooter
          hints={hints}
          onDismissStatus={dismissStatus}
          secondaryActions={secondaryActions}
          status={status}
          statusId={statusId}
        />
      )}
      <PaneResizeHandle
        label="Resize review and log"
        targetSelector=".confirm-sheet"
        edge="bottom"
        minimum={180}
        reserve={36}
        onResize={setReviewHeight}
      />
    </aside>
  )
}

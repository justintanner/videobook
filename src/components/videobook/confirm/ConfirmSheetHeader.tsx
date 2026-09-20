import type { ReactNode } from 'react'
import { ConfirmSheetEffectChip, type ConfirmSheetEffect } from './ConfirmSheetHints'

export function ConfirmSheetHeader({
  actions,
  address,
  effect,
  hints,
  hintsId,
  tag,
  title,
  titleId,
}: {
  actions: ReactNode
  address: string | null
  // What applying does, and the keys that do it. Both are null while the
  // footer is drawn, which is where they read instead.
  effect: ConfirmSheetEffect | null
  hints: ReactNode
  hintsId: string | undefined
  tag: string
  title: string
  titleId: string
}) {
  return (
    <header className="confirm-sheet-head">
      <span className="section-label">{tag}</span>
      <h2 id={titleId}>{title}</h2>
      {address && <span className="confirm-sheet-address">{address}</span>}
      <span className="confirm-sheet-spacer" aria-hidden="true" />
      {effect && <ConfirmSheetEffectChip effect={effect} />}
      {hints && (
        <>
          <span className="confirm-sheet-head-divider" aria-hidden="true" />
          <span id={hintsId} className="confirm-sheet-head-hints">{hints}</span>
        </>
      )}
      {actions}
    </header>
  )
}

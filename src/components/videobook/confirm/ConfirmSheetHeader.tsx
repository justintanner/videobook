import type { ReactNode } from 'react'

export function ConfirmSheetHeader({
  actions,
  address,
  tag,
  title,
  titleId,
}: {
  actions: ReactNode
  address: string | null
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
      {actions}
    </header>
  )
}

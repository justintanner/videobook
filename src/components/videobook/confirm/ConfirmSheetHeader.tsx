import { TriangleAlert } from 'lucide-react'

export interface ConfirmSheetEffect {
  label: string
  tone: 'default' | 'warning'
}

export function ConfirmSheetHeader({
  address,
  effect,
  tag,
  title,
  titleId,
}: {
  address: string | null
  effect: ConfirmSheetEffect | null
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
      {effect && (
        <span className={`confirm-sheet-effect confirm-sheet-effect-${effect.tone}`}>
          {effect.tone === 'warning' && <TriangleAlert size={11} aria-hidden="true" />}
          {effect.label}
        </span>
      )}
    </header>
  )
}

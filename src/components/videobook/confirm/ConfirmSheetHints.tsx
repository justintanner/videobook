import { TriangleAlert } from 'lucide-react'

export interface ConfirmSheetEffect {
  label: string
  tone: 'default' | 'warning'
}

/* The four keys every sheet answers to. They read the same wherever they are
   drawn -- beside Apply in the header while the sheet is ready, in the footer
   row once something else needs that row anyway. */
export function ConfirmSheetReadyHints() {
  return (
    <span>
      <kbd>↵</kbd> apply · <kbd>Esc</kbd> cancel · <kbd>⌘↵</kbd> apply from any field · <kbd>Tab</kbd> moves through settings
    </span>
  )
}

export function ConfirmSheetEffectChip({ effect }: { effect: ConfirmSheetEffect }) {
  return (
    <span className={`confirm-sheet-effect confirm-sheet-effect-${effect.tone}`}>
      {effect.tone === 'warning' && <TriangleAlert size={11} aria-hidden="true" />}
      {effect.label}
    </span>
  )
}

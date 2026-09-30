import { useContext } from 'react'
import { X } from 'lucide-react'
import { ComposerDockContext } from './composer-dock-context'

/* The dock's close control, drawn inside a contextual panel's own header row
   instead of the strip the composer used to stack above it. Renders nothing
   when no composer offers the action, so a panel can host it unconditionally. */
export function ComposerDockClose({ label, shortcut, divider = true }: {
  label?: string
  shortcut?: boolean
  divider?: boolean
}) {
  const dock = useContext(ComposerDockContext)
  if (!dock) return null
  return (
    <>
      {divider && <span className="composer-dock-close-divider" aria-hidden="true" />}
      <button
        type="button"
        className={label ? 'composer-dock-close composer-dock-close-labeled' : 'composer-dock-close'}
        data-composer-dock-hide=""
        aria-label={label ?? dock.hideLabel}
        aria-keyshortcuts={shortcut ? 'Escape' : undefined}
        title={`${label ?? dock.hideLabel}${shortcut ? ' (Esc)' : ''}`}
        onClick={dock.hide}
      >
        {label ?? <X size={14} />}
        {shortcut && <kbd aria-hidden="true">Esc</kbd>}
      </button>
    </>
  )
}

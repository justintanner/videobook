import { useContext } from 'react'
import { X } from 'lucide-react'
import { ComposerDockContext } from './composer-dock-context'

/* The dock's close control, drawn inside a contextual panel's own header row
   instead of the strip the composer used to stack above it. Renders nothing
   when no composer offers the action, so a panel can host it unconditionally. */
export function ComposerDockClose() {
  const dock = useContext(ComposerDockContext)
  if (!dock) return null
  return (
    <>
      <span className="composer-dock-close-divider" aria-hidden="true" />
      <button
        type="button"
        className="composer-dock-close"
        data-composer-dock-hide=""
        aria-label={dock.hideLabel}
        title={dock.hideLabel}
        onClick={dock.hide}
      >
        <X size={15} />
      </button>
    </>
  )
}

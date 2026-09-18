import { createContext } from 'react'

// Hiding the dock belongs to the composer — it stops voice and pauses media on
// the way out — but the control belongs in whatever header row the contextual
// panel already draws. The composer hands that one action down; a panel that
// takes it renders the control itself and the composer drops its own strip.
export interface ComposerDockControls {
  hide: () => void
  hideLabel: string
}

export const ComposerDockContext = createContext<ComposerDockControls | null>(null)

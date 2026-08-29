import { createContext } from 'react'

export interface ComposerOutcomeMessage {
  ok: boolean
  message: string
}

export interface ComposerNoticeMessage {
  message: string
  tone: 'error' | 'info'
}

// What the command composer knows about the last execute and the app-level
// notice. While a confirm sheet is open it renders these in its footer instead
// of the composer's own result strip.
export interface ComposerOutcomeSlot {
  outcome: ComposerOutcomeMessage | null
  notice: ComposerNoticeMessage | null
  dismissOutcome: () => void
  dismissNotice: () => void
}

export const ComposerOutcomeContext = createContext<ComposerOutcomeSlot | null>(null)

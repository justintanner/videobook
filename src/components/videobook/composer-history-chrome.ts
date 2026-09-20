import { createContext } from 'react'

export interface ComposerHistoryChromeValue {
  idle: boolean
  hosted: boolean
  open: boolean
  captionId: string
  onToggle: () => void
}

export const ComposerHistoryChromeContext = createContext<ComposerHistoryChromeValue | null>(null)

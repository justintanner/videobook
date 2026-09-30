import { createContext } from 'react'

export interface ComposerHistoryChromeValue {
  captionId: string
}

export const ComposerHistoryChromeContext = createContext<ComposerHistoryChromeValue | null>(null)

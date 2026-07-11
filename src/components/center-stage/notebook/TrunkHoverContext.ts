import { createContext } from 'react'

export const TrunkHoverContext = createContext<{
  hoveredGroupId: string | null
  setHoveredGroupId: (id: string | null) => void
}>({
  hoveredGroupId: null,
  setHoveredGroupId: () => {},
})

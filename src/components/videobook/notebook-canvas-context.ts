import { createContext } from 'react'
import type { ComposerOutcome } from '@/components/videobook/CommandComposer'
import type { NotebookTimelineProps } from '@/components/videobook/NotebookTimeline'

export type MediaSlotOperation = 'attach' | 'upload'

export type MediaSlotState = {
  operation: MediaSlotOperation | null
  error: string | null
}

export type MediaSlotContextValue = {
  ready: boolean
  states: Record<string, MediaSlotState>
  onFile: (cellId: string, file: File) => void
  onFileError: (cellId: string, message: string) => void
  onOpenLibrary: (cellId: string) => void
}

export type CellContextMenuContextValue = {
  openCellId: string | null
  open: (
    cellId: string,
    position: { x: number; y: number },
    returnFocus: HTMLElement | null,
  ) => void
}

export const MediaSlotContext = createContext<MediaSlotContextValue>({
  ready: false,
  states: {},
  onFile: () => undefined,
  onFileError: () => undefined,
  onOpenLibrary: () => undefined,
})

export const CellRunContext = createContext<(
  cellId: string,
) => Promise<ComposerOutcome | undefined>>(
  async () => undefined,
)

export const PrimaryCellContext = createContext<string | null>(null)

export const GenerationTitlesContext = createContext<ReadonlyMap<string, string>>(
  new Map(),
)

export const CellContextMenuContext = createContext<CellContextMenuContextValue>({
  openCellId: null,
  open: () => undefined,
})

export function cellContextMenuId(cellId: string): string {
  return `cell-context-menu-${cellId}`
}

export type TimelineContextValue = Omit<NotebookTimelineProps, 'address' | 'onSeek' | 'onPreview' | 'onRemove'> & {
  onSeek: (cellId: string, frame: number) => void
  onPreview: (cellId: string) => void
  onRemove: (cellId: string) => void
}

export const TimelineContext = createContext<TimelineContextValue | null>(null)

import type { UIEvent } from 'react'
import type { GenerationReviewSource } from '@/components/videobook/confirm/bodies/GenerationBody'
import type { GenerationSlotEditor } from '@/components/videobook/GenerationInputSlots'

export type PromptTokenSources = ReadonlyMap<string, GenerationReviewSource>

export function promptTokenSources(editor: GenerationSlotEditor | undefined): PromptTokenSources {
  if (!editor) return new Map()
  const items = [...editor.layout.slots.flatMap((column) => column.items), ...editor.layout.unplaced]
  return new Map(items.flatMap((item) => {
    const token = item.port ? editor.tokens.get(`${item.sourceCellId}:${item.port}`) : undefined
    const source = editor.cells.get(item.sourceCellId)
    return token && source ? [[token, source] as const] : []
  }))
}

export function syncPromptTokenLayer(layer: HTMLDivElement | null, event: UIEvent<HTMLTextAreaElement>): void {
  if (layer) layer.scrollTop = event.currentTarget.scrollTop
}

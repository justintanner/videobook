import { useCallback, useRef, useState } from 'react'
import type { NotebookDocument } from 'videobook-engine'
import { isNotebookGenerationCellType } from './notebook-cell-types'

export type GenerationCellPreview = {
  value: unknown
  loading: boolean
  error: string | null
}

type SelectedPreview = GenerationCellPreview & {
  scope: string
  cellId: string
}

export function useGenerationCellPreview({
  bookId,
  notebook,
  ready,
  call,
}: {
  bookId: string | null
  notebook: NotebookDocument | null
  ready: boolean
  call: (tool: string, args: Record<string, unknown>, options?: { background?: boolean }) => Promise<unknown>
}) {
  const [preview, setPreview] = useState<SelectedPreview | null>(null)
  const requestRef = useRef<{ key: string } | null>(null)
  const scope = `${bookId}:${notebook?.id}`
  const select = useCallback((cellId: string | null, initialValue?: unknown) => {
    const cell = notebook?.cells.find((candidate) => candidate.id === cellId)
    if (!bookId || !notebook || !cellId || (initialValue === undefined && (!cell || !isNotebookGenerationCellType(cell.type)))) {
      requestRef.current = null
      setPreview(null)
      return
    }
    const identity = { scope, cellId }
    if (initialValue !== undefined) {
      requestRef.current = null
      setPreview({ ...identity, value: initialValue, loading: false, error: null })
      return
    }
    if (!cell) return
    if (!ready) return
    const key = JSON.stringify([scope, cell, notebook.edges.filter((edge) => edge.target === cellId)])
    if (requestRef.current?.key === key) return
    const request = { key }
    requestRef.current = request
    setPreview({ ...identity, value: null, loading: true, error: null })
    void call('preview_notebook_generation', {
      book_id: bookId,
      notebook_id: notebook.id,
      cell_id: cell.id,
    }, { background: true }).then((value) => {
      if (requestRef.current !== request) return
      setPreview({ ...identity, value, loading: false, error: null })
    }).catch((error: unknown) => {
      if (requestRef.current !== request) return
      requestRef.current = null
      setPreview({
        ...identity,
        value: null,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }, [bookId, call, notebook, ready, scope])

  return { preview: preview?.scope === scope ? preview : null, select }
}

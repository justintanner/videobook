import { useCallback, useMemo, useRef, useState } from 'react'
import type { TagFacet } from 'videobook-engine/tag-values'
import { parseAssetTags, type AssetTags } from './asset-tags'
import { resolveTagInput } from '../../server/src/tag-vocabulary'
import {
  applyTagEdit,
  visibleSuggestions,
  type TagEdit,
  type TagEditAction,
  type TagSuggestion,
} from './asset-tag-editing'

type ToolCall = (
  tool: string,
  args: Record<string, unknown>,
  options?: { background?: boolean },
) => Promise<unknown>

type AssetTagTarget = {
  bookId: string
  assetId: string
}

type UseAssetTagsInput = {
  /** Null while the MCP connection is not ready; edits are disabled then. */
  call: ToolCall | null
  target: AssetTagTarget | null
  /** Canonical state from the asset payload, refreshed in the background. */
  tags: AssetTags | null
}

type AssetTagsController = {
  tags: AssetTags | null
  /** True while an edit is in flight; chips stay interactive regardless. */
  busy: boolean
  error: string | null
  canEdit: boolean
  suggestions: TagSuggestion[]
  addTag: (edit: TagEdit) => Promise<void>
  removeTag: (edit: TagEdit) => Promise<void>
  restoreTag: (edit: TagEdit) => Promise<void>
  loadSuggestions: (prefix: string, facet?: TagFacet) => Promise<void>
  clearError: () => void
}

function readTags(response: unknown): AssetTags | null {
  const payload = response as { tags?: unknown } | null
  return payload ? parseAssetTags(payload.tags) : null
}

function readSuggestions(response: unknown): TagSuggestion[] {
  const payload = response as { suggestions?: unknown } | null
  if (!payload || !Array.isArray(payload.suggestions)) return []
  return payload.suggestions.flatMap((entry) => {
    const row = entry as Record<string, unknown>
    const facet = typeof row.facet === 'string' ? (row.facet as TagFacet) : null
    const key = typeof row.key === 'string' ? row.key : null
    const label = typeof row.label === 'string' ? row.label : null
    if (!facet || !key || !label) return []
    const assets = Number(row.assets)
    return [{
      facet,
      key,
      label,
      assets: Number.isFinite(assets) ? assets : 0,
    }]
  })
}

const TOOL_BY_ACTION: Record<TagEditAction, string> = {
  add: 'add_asset_tag',
  remove: 'remove_asset_tag',
  restore: 'restore_asset_tag',
}

type PendingEdit = { id: number; edit: TagEdit; action: TagEditAction }

type EditorState = {
  targetKey: string
  source: string
  canonical: AssetTags | null
  pending: PendingEdit[]
  error: string | null
}

export function useAssetTags({ call, target, tags }: UseAssetTagsInput): AssetTagsController {
  const targetKey = target ? `${target.bookId}/${target.assetId}` : ''
  const source = JSON.stringify(tags)
  const [local, setLocal] = useState<EditorState>({
    targetKey, source, canonical: tags, pending: [], error: null,
  })
  const [rawSuggestions, setRawSuggestions] = useState<{ targetKey: string; tags: TagSuggestion[] }>({
    targetKey, tags: [],
  })
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  const editRequestRef = useRef(0)
  const suggestRequestRef = useRef(0)
  let current = local
  if (local.targetKey !== targetKey || local.source !== source) {
    current = {
      targetKey, source, canonical: tags,
      pending: local.targetKey === targetKey ? local.pending : [],
      error: local.targetKey === targetKey ? local.error : null,
    }
    setLocal(current)
  }
  const effective = current.pending.reduce<AssetTags | null>(
    (state, pending) => applyTagEdit(state, pending.edit, pending.action),
    current.canonical,
  )

  const runEdit = useCallback((input: TagEdit, action: TagEditAction): Promise<void> => {
    if (!call || !target) return Promise.resolve()
    let edit: TagEdit
    try {
      edit = resolveTagInput(input, [
        ...(effective?.effective ?? []), ...(effective?.dismissed ?? []),
        ...(rawSuggestions.targetKey === targetKey ? rawSuggestions.tags : []),
      ])
    } catch (cause) {
      setLocal((state) => ({ ...state, error: cause instanceof Error ? cause.message : String(cause) }))
      return Promise.resolve()
    }
    const id = ++editRequestRef.current
    setLocal((state) => ({ ...state, pending: [...state.pending, { id, edit, action }], error: null }))
    const operation = queueRef.current.then(async () => {
      try {
        const response = await call(TOOL_BY_ACTION[action], {
          book_id: target.bookId, asset_id: target.assetId, facet: edit.facet, label: edit.label,
        })
        const canonical = readTags(response)
        if (!canonical) throw new Error('The server returned no tag state')
        setLocal((state) => {
          if (state.targetKey !== targetKey || !state.pending.some((pending) => pending.id === id)) return state
          return {
            ...state,
            canonical: state.source === source ? canonical : applyTagEdit(state.canonical, edit, action),
            pending: state.pending.filter((pending) => pending.id !== id),
          }
        })
      } catch (cause) {
        setLocal((state) => {
          if (state.targetKey !== targetKey || !state.pending.some((pending) => pending.id === id)) return state
          return {
            ...state, pending: state.pending.filter((pending) => pending.id !== id),
            error: cause instanceof Error ? cause.message : String(cause),
          }
        })
      }
    })
    queueRef.current = operation
    return operation
  }, [call, effective, rawSuggestions, source, target, targetKey])

  const addTag = useCallback((edit: TagEdit) => runEdit(edit, 'add'), [runEdit])
  const removeTag = useCallback((edit: TagEdit) => runEdit(edit, 'remove'), [runEdit])
  const restoreTag = useCallback((edit: TagEdit) => runEdit(edit, 'restore'), [runEdit])

  const loadSuggestions = useCallback(async (prefix: string, facet?: TagFacet): Promise<void> => {
    if (!call || !target) return
    const request = ++suggestRequestRef.current
    try {
      const response = await call('suggest_asset_tags', {
        book_id: target.bookId,
        ...(prefix.trim() ? { prefix: prefix.trim() } : {}),
        ...(facet ? { facet } : {}), limit: 20,
      }, { background: true })
      if (suggestRequestRef.current === request) setRawSuggestions({ targetKey, tags: readSuggestions(response) })
    } catch {
      if (suggestRequestRef.current === request) setRawSuggestions({ targetKey, tags: [] })
    }
  }, [call, target, targetKey])

  const suggestions = useMemo(
    () => visibleSuggestions(rawSuggestions.targetKey === targetKey ? rawSuggestions.tags : [], effective?.effective ?? []),
    [effective, rawSuggestions, targetKey],
  )
  const clearError = useCallback(() => setLocal((state) => ({ ...state, error: null })), [])

  return {
    tags: effective, busy: current.pending.length > 0, error: current.error,
    canEdit: Boolean(call && target), suggestions,
    addTag, removeTag, restoreTag, loadSuggestions, clearError,
  }
}

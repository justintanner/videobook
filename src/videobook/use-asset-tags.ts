import { useCallback, useMemo, useRef, useState } from 'react'
import type { TagFacet } from 'videobook-engine/tag-values'
import { parseAssetTags, type AssetTags } from './asset-tags'
import {
  applyTagEdit,
  visibleSuggestions,
  type TagEdit,
  type TagEditAction,
  type TagSuggestion,
} from './asset-tag-editing'

/**
 * Tag editing against the MCP tools.
 *
 * The component that renders chips should not know tool names, argument
 * shapes or how a stale response is recognised, so all three live here. Three
 * rules the hook exists to keep:
 *
 * - An edit is applied locally first and replaced by the server's canonical
 *   state when it lands. A failure rolls the prediction back and surfaces the
 *   message rather than leaving a chip that lies.
 * - Only the newest request may write state. Tag edits arrive faster than
 *   round trips when someone is typing, and an older reply must not resurrect
 *   a tag that was just removed.
 * - Background analysis keeps arriving while someone types. A fresh payload
 *   replaces the local prediction only once it reflects that prediction,
 *   which is what stops a half-typed edit from being undone underneath the
 *   person making it.
 */

type ToolCall = (
  tool: string,
  args: Record<string, unknown>,
  options?: { background?: boolean },
) => Promise<unknown>

export type AssetTagTarget = {
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

export type AssetTagsController = {
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

export function useAssetTags({
  call,
  target,
  tags,
}: UseAssetTagsInput): AssetTagsController {
  const [local, setLocal] = useState<{
    assetId: string
    tags: AssetTags
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rawSuggestions, setRawSuggestions] = useState<TagSuggestion[]>([])
  const editRequestRef = useRef(0)
  const suggestRequestRef = useRef(0)

  // Derived during render rather than synced in an effect: a local prediction
  // survives only until the payload catches up with it, and never outlives a
  // switch to another asset.
  const effective = local && target && local.assetId === target.assetId
    ? local.tags
    : tags

  const canEdit = Boolean(call && target)

  const runEdit = useCallback(async (
    edit: TagEdit,
    action: TagEditAction,
  ): Promise<void> => {
    if (!call || !target) return
    const assetId = target.assetId
    const previous = effective
    const predicted = applyTagEdit(previous, edit, action)
    const request = editRequestRef.current + 1
    editRequestRef.current = request
    setLocal({ assetId, tags: predicted })
    setBusy(true)
    setError(null)
    try {
      const response = await call(TOOL_BY_ACTION[action], {
        book_id: target.bookId,
        asset_id: assetId,
        facet: edit.facet,
        label: edit.label,
      })
      if (editRequestRef.current !== request) return
      const canonical = readTags(response)
      setLocal(canonical ? { assetId, tags: canonical } : null)
    } catch (cause) {
      if (editRequestRef.current !== request) return
      // The prediction was wrong: put the chips back the way they were and
      // say why, rather than leaving the edit looking applied.
      setLocal(previous ? { assetId, tags: previous } : null)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (editRequestRef.current === request) setBusy(false)
    }
  }, [call, effective, target])

  const addTag = useCallback(
    (edit: TagEdit) => runEdit(edit, 'add'),
    [runEdit],
  )
  const removeTag = useCallback(
    (edit: TagEdit) => runEdit(edit, 'remove'),
    [runEdit],
  )
  const restoreTag = useCallback(
    (edit: TagEdit) => runEdit(edit, 'restore'),
    [runEdit],
  )

  const loadSuggestions = useCallback(async (
    prefix: string,
    facet?: TagFacet,
  ): Promise<void> => {
    if (!call || !target) return
    const request = suggestRequestRef.current + 1
    suggestRequestRef.current = request
    try {
      const response = await call('suggest_asset_tags', {
        book_id: target.bookId,
        ...(prefix.trim() ? { prefix: prefix.trim() } : {}),
        ...(facet ? { facet } : {}),
        limit: 20,
      }, { background: true })
      if (suggestRequestRef.current !== request) return
      setRawSuggestions(readSuggestions(response))
    } catch {
      // Autocomplete is an aid, not an operation: a failed lookup leaves the
      // last suggestions in place and never blocks typing.
      if (suggestRequestRef.current === request) setRawSuggestions([])
    }
  }, [call, target])

  const suggestions = useMemo(
    () => visibleSuggestions(rawSuggestions, effective?.effective ?? []),
    [effective, rawSuggestions],
  )

  const clearError = useCallback(() => setError(null), [])

  return {
    tags: effective,
    busy,
    error,
    canEdit,
    suggestions,
    addTag,
    removeTag,
    restoreTag,
    loadSuggestions,
    clearError,
  }
}

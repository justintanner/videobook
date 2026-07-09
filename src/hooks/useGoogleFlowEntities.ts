import { useCallback, useMemo, useRef, useState } from 'react'
import type { UseMcpResult } from 'use-mcp/react'

export type GoogleFlowEntityKind = 'voice' | 'character'

export interface GoogleFlowEntityOption {
  ref: string
  displayName: string
}

interface UseGoogleFlowEntitiesResult {
  entities: GoogleFlowEntityOption[]
  loading: boolean
  loaded: boolean
  error: string | null
  refresh: () => Promise<void>
  ensureLoaded: () => Promise<void>
}

/** Pure normalizer for list_google_flow_voices / list_google_flow_characters JSON. */
export function normalizeGoogleFlowEntities(
  text: string,
  kind: GoogleFlowEntityKind,
): GoogleFlowEntityOption[] {
  const parsed = JSON.parse(text) as unknown
  const obj = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  const plural = kind === 'voice' ? 'voices' : 'characters'
  const rawList = Array.isArray(obj[plural])
    ? obj[plural]
    : Array.isArray(obj)
      ? obj
      : []
  const out: GoogleFlowEntityOption[] = []
  for (const item of rawList) {
    if (typeof item === 'string' && item.trim()) {
      out.push({ ref: item.trim(), displayName: item.trim() })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const ref = typeof rec.ref === 'string' && rec.ref.trim()
      ? rec.ref.trim()
      : typeof rec[kind] === 'string' && (rec[kind] as string).trim()
        ? (rec[kind] as string).trim()
        : typeof rec.id === 'string' && rec.id.trim()
          ? rec.id.trim()
          : ''
    if (!ref) continue
    const displayName =
      typeof rec.display_name === 'string' && rec.display_name.trim()
        ? rec.display_name.trim()
        : typeof rec.displayName === 'string' && rec.displayName.trim()
          ? rec.displayName.trim()
          : typeof rec.name === 'string' && rec.name.trim()
            ? rec.name.trim()
            : ref
    out.push({ ref, displayName })
  }
  return out
}

export function useGoogleFlowEntities(
  kind: GoogleFlowEntityKind,
  callTool: UseMcpResult['callTool'] | undefined,
  state: UseMcpResult['state'] | undefined,
): UseGoogleFlowEntitiesResult {
  const [entities, setEntities] = useState<GoogleFlowEntityOption[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlightRef = useRef<Promise<void> | null>(null)

  const toolName = kind === 'voice' ? 'list_google_flow_voices' : 'list_google_flow_characters'
  // Prefer user-saved voices; characters have no source filter.
  const toolArgs = useMemo(
    () => (kind === 'voice' ? { source: 'user' as const } : {}),
    [kind],
  )

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return inFlightRef.current
    const run = (async () => {
      if (!callTool) {
        setError('MCP callTool unavailable')
        return
      }
      if (state !== undefined && state !== 'ready') {
        setError('MCP connection is not ready')
        return
      }
      setLoading(true)
      setError(null)
      try {
        const result = await callTool(toolName, toolArgs)
        const content = result.content as Array<{ type: string; text: string }> | undefined
        const text = content?.[0]?.text
        if (result.isError) {
          setError(text ?? `${toolName} failed`)
          return
        }
        if (!text) {
          setError(`${toolName} returned no data`)
          return
        }
        setEntities(normalizeGoogleFlowEntities(text, kind))
        setLoaded(true)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
        inFlightRef.current = null
      }
    })()
    inFlightRef.current = run
    return run
  }, [callTool, state, toolName, kind, toolArgs])

  const ensureLoaded = useCallback(async () => {
    if (loaded || loading) return
    await refresh()
  }, [loaded, loading, refresh])

  return { entities, loading, loaded, error, refresh, ensureLoaded }
}

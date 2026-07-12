import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { UseMcpResult } from 'use-mcp/react'
import { GOOGLE_FLOW_VOICE_PRESETS } from '@/lib/google-flow-voice-presets'

export type GoogleFlowEntityKind = 'voice' | 'character'
export type GoogleFlowEntitySource = 'system' | 'user'

export interface GoogleFlowEntityOption {
  ref: string
  displayName: string
  source?: GoogleFlowEntitySource
  /** Signed preview URL from list enrichment (characters only). */
  thumbnailUrl?: string | null
  /** Number of source images (characters only, from server image_count). */
  image_count?: number | null
}

interface UseGoogleFlowEntitiesResult {
  entities: GoogleFlowEntityOption[]
  systemEntities: GoogleFlowEntityOption[]
  userEntities: GoogleFlowEntityOption[]
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
  source?: GoogleFlowEntitySource,
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
      out.push({
        ref: item.trim(),
        displayName: item.trim(),
        ...(source ? { source } : {}),
      })
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
          : typeof rec.baseVoice === 'string' && rec.baseVoice.trim() && source === 'system'
            ? rec.baseVoice.trim()
            : ''
    if (!ref) continue
    const displayName =
      typeof rec.display_name === 'string' && rec.display_name.trim()
        ? rec.display_name.trim()
        : typeof rec.displayName === 'string' && rec.displayName.trim()
          ? rec.displayName.trim()
          : typeof rec.name === 'string' && rec.name.trim()
            ? rec.name.trim()
            : typeof rec.baseVoice === 'string' && rec.baseVoice.trim()
              ? rec.baseVoice.trim()
              : ref
    const thumbnailUrl =
      typeof rec.thumbnail_url === 'string' && rec.thumbnail_url.trim()
        ? rec.thumbnail_url.trim()
        : typeof rec.thumbnailUrl === 'string' && rec.thumbnailUrl.trim()
          ? rec.thumbnailUrl.trim()
          : null
    const itemSource: GoogleFlowEntitySource | undefined =
      source
      ?? (rec.source === 'system' || rec.source === 'user' ? rec.source : undefined)
    const imageCount =
      typeof rec.image_count === 'number' ? rec.image_count
      : typeof rec.imageCount === 'number' ? rec.imageCount
      : null
    out.push({
      ref,
      displayName,
      ...(itemSource ? { source: itemSource } : {}),
      ...(kind === 'character' ? { thumbnailUrl, image_count: imageCount } : {}),
    })
  }
  return out
}

/** Merge live system/user voice lists; fall back to the 30 hard-coded presets
 *  when the system list is empty so the picker is never blank. */
export function mergeVoiceLists(
  systemLive: GoogleFlowEntityOption[],
  userLive: GoogleFlowEntityOption[],
): GoogleFlowEntityOption[] {
  const system = systemLive.length > 0
    ? systemLive.map((e) => ({ ...e, source: 'system' as const }))
    : GOOGLE_FLOW_VOICE_PRESETS.map((name) => ({
        ref: name,
        displayName: name,
        source: 'system' as const,
      }))
  const user = userLive.map((e) => ({ ...e, source: 'user' as const }))
  // Prefer custom when ref collides (unlikely across system names vs user refs).
  const seen = new Set<string>()
  const out: GoogleFlowEntityOption[] = []
  for (const e of [...user, ...system]) {
    if (seen.has(e.ref)) continue
    seen.add(e.ref)
    out.push(e)
  }
  return out
}

export function pickImageSlugCandidates(formValues: Record<string, unknown>): string[] {
  const fromArray = Array.isArray(formValues.image_slugs)
    ? (formValues.image_slugs as unknown[]).map(String).filter((s) => s.trim() !== '')
    : []
  const firstFrame = typeof formValues.first_frame_slug === 'string'
    ? formValues.first_frame_slug.trim()
    : ''
  const out: string[] = []
  const seen = new Set<string>()
  for (const slug of [...fromArray, ...(firstFrame ? [firstFrame] : [])]) {
    if (seen.has(slug)) continue
    seen.add(slug)
    out.push(slug)
  }
  return out.slice(0, 2)
}

async function callListTool(
  callTool: UseMcpResult['callTool'],
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await callTool(toolName, args)
  const content = result.content as Array<{ type: string; text: string }> | undefined
  const text = content?.[0]?.text
  if (result.isError) {
    throw new Error(text ?? `${toolName} failed`)
  }
  if (!text) {
    throw new Error(`${toolName} returned no data`)
  }
  return text
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
        if (kind === 'voice') {
          // System + custom in parallel. System list failure still falls back
          // to hard-coded presets so the picker is never empty.
          const [systemResult, userResult] = await Promise.allSettled([
            callListTool(callTool, 'list_google_flow_voices', { source: 'system' }),
            callListTool(callTool, 'list_google_flow_voices', { source: 'user' }),
          ])
          const systemLive = systemResult.status === 'fulfilled'
            ? normalizeGoogleFlowEntities(systemResult.value, 'voice', 'system')
            : []
          const userLive = userResult.status === 'fulfilled'
            ? normalizeGoogleFlowEntities(userResult.value, 'voice', 'user')
            : []
          if (systemResult.status === 'rejected' && userResult.status === 'rejected') {
            // Both failed — still offer presets offline, surface one error.
            setEntities(mergeVoiceLists([], []))
            setError(
              systemResult.reason instanceof Error
                ? systemResult.reason.message
                : String(systemResult.reason),
            )
          } else {
            setEntities(mergeVoiceLists(systemLive, userLive))
            if (userResult.status === 'rejected') {
              setError(
                userResult.reason instanceof Error
                  ? userResult.reason.message
                  : String(userResult.reason),
              )
            }
          }
        } else {
          const text = await callListTool(callTool, 'list_google_flow_characters', {})
          setEntities(normalizeGoogleFlowEntities(text, 'character', 'user'))
        }
        setLoaded(true)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        if (kind === 'voice') {
          // Offline presets so Voice Refs is still usable.
          setEntities(mergeVoiceLists([], []))
          setLoaded(true)
        }
      } finally {
        setLoading(false)
        inFlightRef.current = null
      }
    })()
    inFlightRef.current = run
    return run
  }, [callTool, state, kind])

  const ensureLoaded = useCallback(async () => {
    if (loaded || loading) return
    await refresh()
  }, [loaded, loading, refresh])

  // Characters need names/thumbs without waiting for a select focus.
  useEffect(() => {
    if (kind !== 'character') return
    if (!callTool) return
    if (state !== undefined && state !== 'ready') return
    if (loaded || loading) return
    void ensureLoaded()
  }, [kind, callTool, state, loaded, loading, ensureLoaded])

  const systemEntities = useMemo(
    () => entities.filter((e) => e.source === 'system'),
    [entities],
  )
  const userEntities = useMemo(
    () => entities.filter((e) => e.source !== 'system'),
    [entities],
  )

  return {
    entities,
    systemEntities,
    userEntities,
    loading,
    loaded,
    error,
    refresh,
    ensureLoaded,
  }
}

import { canonicalCharacterId } from '@/components/gen/ui/media-strip'

export async function resolveGoogleFlowCharacterRefs(
  callTool: UseMcpResult['callTool'],
  refs: string[]
): Promise<string[]> {
  const listResult = await callTool('list_google_flow_characters', { include_previews: false })
  if (listResult.isError) {
    const content = listResult.content as Array<{ type: string; text: string }> | undefined
    throw new Error(String(content?.[0]?.text ?? 'list_google_flow_characters failed'))
  }
  const content = listResult.content as Array<{ type: string; text: string }> | undefined
  const text = content?.[0]?.text
  if (!text) throw new Error('list_google_flow_characters returned no data')

  const parsed = JSON.parse(text) as { characters: { ref: string; display_name?: string }[] }
  if (!parsed.characters) return refs

  const canonicalToLive = new Map<string, string>()
  const canonicalToName = new Map<string, string>()
  for (const char of parsed.characters) {
    const canonical = canonicalCharacterId(char.ref)
    canonicalToLive.set(canonical, char.ref)
    canonicalToName.set(canonical, char.display_name ?? canonical)
  }

  return refs.map((ref) => {
    if (!ref.trim()) return ref
    const canonical = canonicalCharacterId(ref)
    const liveRef = canonicalToLive.get(canonical)
    if (!liveRef) {
      // canonicalToName here is only populated with existing characters, so it won't help for deleted ones.
      // But wait, useNotebookRun had `const name = canonicalToName.get(canonical) ?? ref`, which is actually 
      // not very helpful for deleted ones unless the old name is stored somewhere. 
      // However, we should just keep it as useNotebookRun had it.
      const name = canonicalToName.get(canonical) ?? ref
      throw new Error(`Character not found upstream: ${name}`)
    }
    return liveRef
  })
}

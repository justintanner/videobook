import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import {
  nonBlankStringValue,
  nonEmptyStringValue,
  recordValue,
} from './value-decoders'

type SpeakVoiceSource = 'custom' | 'generic'

export interface SpeakVoice {
  voiceId: string
  name: string
  source: SpeakVoiceSource
  category?: string
  previewUrl?: string
}

export interface ElevenLabsVoiceCatalog {
  voices: SpeakVoice[]
  status: 'live' | 'fallback'
  warning: string | null
}

type VoiceCatalogCallTool = (
  tool: string,
  args: Record<string, unknown>,
  options?: { background?: boolean },
) => Promise<unknown>

export type ElevenLabsVoicesState = ElevenLabsVoiceCatalog & {
  loading: boolean
  error: string | null
  ensureLoaded: () => Promise<ElevenLabsVoiceCatalog | null>
  refresh: () => Promise<ElevenLabsVoiceCatalog | null>
}

type ElevenLabsVoiceCatalogSnapshot = ElevenLabsVoiceCatalog & {
  loading: boolean
  error: string | null
}

type ElevenLabsVoiceCatalogLoader = () => Promise<ElevenLabsVoiceCatalog>

interface ElevenLabsVoiceCatalogLifecycle {
  configure: (options: {
    ready: boolean
    load: ElevenLabsVoiceCatalogLoader
  }) => void
  ensureLoaded: () => Promise<ElevenLabsVoiceCatalog | null>
  getSnapshot: () => ElevenLabsVoiceCatalogSnapshot
  refresh: () => Promise<ElevenLabsVoiceCatalog | null>
  reset: () => void
  subscribe: (listener: () => void) => () => void
}

export function parseSpeakVoiceCatalog(value: unknown): ElevenLabsVoiceCatalog {
  const payload = recordValue(value)
  const voices = Array.isArray(payload?.voices)
    ? payload.voices.flatMap((entry): SpeakVoice[] => {
      const item = recordValue(entry)
      const voiceId = nonBlankStringValue(item?.voice_id)
        ?? nonBlankStringValue(item?.voiceId)
      const name = nonBlankStringValue(item?.name)
      const source = nonBlankStringValue(item?.source)
      if (!voiceId || !name || (source !== 'custom' && source !== 'generic')) {
        return []
      }
      const category = nonBlankStringValue(item?.category)
      const previewUrl = nonBlankStringValue(item?.preview_url)
        ?? nonBlankStringValue(item?.previewUrl)
      return [{
        voiceId,
        name,
        source,
        ...(category ? { category } : {}),
        ...(previewUrl ? { previewUrl } : {}),
      }]
    })
    : []
  return {
    voices,
    status: payload?.status === 'live' ? 'live' : 'fallback',
    warning: nonEmptyStringValue(payload?.warning),
  }
}

export async function fetchElevenLabsVoiceCatalog(
  callTool: VoiceCatalogCallTool,
): Promise<ElevenLabsVoiceCatalog> {
  return parseSpeakVoiceCatalog(
    await callTool('list_elevenlabs_voices', {}, { background: true }),
  )
}

function emptyVoiceCatalogSnapshot(): ElevenLabsVoiceCatalogSnapshot {
  return {
    voices: [],
    status: 'fallback',
    warning: null,
    loading: false,
    error: null,
  }
}

export function createElevenLabsVoiceCatalogLifecycle(options: {
  ready: boolean
  load: ElevenLabsVoiceCatalogLoader
}): ElevenLabsVoiceCatalogLifecycle {
  let ready = options.ready
  let load = options.load
  let generation = 0
  let loaded = false
  let snapshot = emptyVoiceCatalogSnapshot()
  let inFlight: Promise<ElevenLabsVoiceCatalog | null> | null = null
  const listeners = new Set<() => void>()

  const publish = (next: ElevenLabsVoiceCatalogSnapshot) => {
    snapshot = next
    for (const listener of listeners) listener()
  }

  const reset = () => {
    generation += 1
    loaded = false
    inFlight = null
    publish(emptyVoiceCatalogSnapshot())
  }

  const start = (): Promise<ElevenLabsVoiceCatalog | null> => {
    if (!ready) return Promise.resolve(null)
    if (inFlight) return inFlight
    const requestGeneration = generation
    const request: Promise<ElevenLabsVoiceCatalog | null> = Promise.resolve()
      .then(() => load())
      .then(
        (catalog) => {
          if (generation !== requestGeneration || inFlight !== request) return null
          loaded = true
          inFlight = null
          publish({ ...catalog, loading: false, error: null })
          return catalog
        },
        (cause: unknown) => {
          if (generation !== requestGeneration || inFlight !== request) return null
          loaded = false
          inFlight = null
          publish({
            ...snapshot,
            loading: false,
            error: cause instanceof Error ? cause.message : String(cause),
          })
          return null
        },
      )
    inFlight = request
    publish({ ...snapshot, loading: true, error: null })
    return request
  }

  return {
    configure(next) {
      if (ready === next.ready && load === next.load) return
      ready = next.ready
      load = next.load
      reset()
    },
    ensureLoaded() {
      if (!ready) return Promise.resolve(null)
      if (inFlight) return inFlight
      if (loaded) {
        return Promise.resolve({
          voices: snapshot.voices,
          status: snapshot.status,
          warning: snapshot.warning,
        })
      }
      return start()
    },
    getSnapshot() {
      return snapshot
    },
    refresh: start,
    reset,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function useElevenLabsVoices(options: {
  callTool: VoiceCatalogCallTool
  ready: boolean
}): ElevenLabsVoicesState {
  const { callTool, ready } = options
  const load = useCallback(
    () => fetchElevenLabsVoiceCatalog(callTool),
    [callTool],
  )
  const [lifecycle] = useState(() =>
    createElevenLabsVoiceCatalogLifecycle({ ready, load }))

  useEffect(() => {
    lifecycle.configure({ ready, load })
  }, [lifecycle, load, ready])

  useEffect(() => () => lifecycle.reset(), [lifecycle])

  const snapshot = useSyncExternalStore(
    lifecycle.subscribe,
    lifecycle.getSnapshot,
    lifecycle.getSnapshot,
  )
  const ensureLoaded = useCallback(
    () => lifecycle.ensureLoaded(),
    [lifecycle],
  )
  const refresh = useCallback(
    () => lifecycle.refresh(),
    [lifecycle],
  )

  return {
    voices: snapshot.voices,
    status: snapshot.status,
    warning: snapshot.warning,
    loading: snapshot.loading,
    error: snapshot.error,
    ensureLoaded,
    refresh,
  }
}

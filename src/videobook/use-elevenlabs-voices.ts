import { useCallback, useEffect, useRef, useState } from 'react'

export type SpeakVoiceSource = 'custom' | 'generic'

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

export type VoiceCatalogCallTool = (
  tool: string,
  args: Record<string, unknown>,
  options?: { background?: boolean },
) => Promise<unknown>

export type ElevenLabsVoicesState = ElevenLabsVoiceCatalog & {
  loading: boolean
  error: string | null
  refresh: () => Promise<ElevenLabsVoiceCatalog | null>
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function parseSpeakVoiceCatalog(value: unknown): ElevenLabsVoiceCatalog {
  const payload = record(value)
  const voices = Array.isArray(payload?.voices)
    ? payload.voices.flatMap((entry): SpeakVoice[] => {
      const item = record(entry)
      const voiceId = asString(item?.voice_id) ?? asString(item?.voiceId)
      const name = asString(item?.name)
      const source = asString(item?.source)
      if (!voiceId || !name || (source !== 'custom' && source !== 'generic')) {
        return []
      }
      const category = asString(item?.category)
      const previewUrl = asString(item?.preview_url) ?? asString(item?.previewUrl)
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
    warning: asString(payload?.warning),
  }
}

export async function fetchElevenLabsVoiceCatalog(
  callTool: VoiceCatalogCallTool,
): Promise<ElevenLabsVoiceCatalog> {
  return parseSpeakVoiceCatalog(
    await callTool('list_elevenlabs_voices', {}, { background: true }),
  )
}

export function useElevenLabsVoices(options: {
  callTool: VoiceCatalogCallTool
  ready: boolean
}): ElevenLabsVoicesState {
  const { callTool, ready } = options
  const seededRef = useRef(false)
  const [catalog, setCatalog] = useState<ElevenLabsVoiceCatalog>({
    voices: [],
    status: 'fallback',
    warning: null,
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!ready) return null
    setLoading(true)
    setError(null)
    try {
      const next = await fetchElevenLabsVoiceCatalog(callTool)
      setCatalog(next)
      return next
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      return null
    } finally {
      setLoading(false)
    }
  }, [callTool, ready])

  useEffect(() => {
    if (!ready || seededRef.current) return
    seededRef.current = true
    void refresh().then((catalog) => {
      if (!catalog) seededRef.current = false
    })
  }, [ready, refresh])

  return {
    voices: catalog.voices,
    status: catalog.status,
    warning: catalog.warning,
    loading,
    error,
    refresh,
  }
}

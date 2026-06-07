import { useCallback, useMemo, useRef, useState } from 'react'
import type { UseMcpResult } from 'use-mcp/react'

export type ElevenLabsVoiceSource = 'custom' | 'generic'

export interface ElevenLabsVoiceOption {
  voice_id: string
  name: string
  source: ElevenLabsVoiceSource
  category?: string
  preview_url?: string
}

interface ElevenLabsVoiceListResponse {
  voices: ElevenLabsVoiceOption[]
  status: 'live' | 'fallback'
  warning: string | null
}

interface UseElevenLabsVoicesResult {
  voices: ElevenLabsVoiceOption[]
  customVoices: ElevenLabsVoiceOption[]
  genericVoices: ElevenLabsVoiceOption[]
  loading: boolean
  loaded: boolean
  error: string | null
  warning: string | null
  refresh: () => Promise<void>
  ensureLoaded: () => Promise<void>
}

function normalizeVoices(raw: unknown): ElevenLabsVoiceOption[] {
  const obj = raw && typeof raw === 'object' ? raw as { voices?: unknown } : {}
  const voices = Array.isArray(obj.voices) ? obj.voices : []
  return voices
    .map((voice) => {
      const v = voice && typeof voice === 'object' ? voice as Record<string, unknown> : {}
      const voiceId = typeof v.voice_id === 'string' ? v.voice_id.trim() : ''
      if (!voiceId) return null
      const name = typeof v.name === 'string' && v.name.trim() ? v.name.trim() : voiceId
      const source = v.source === 'custom' ? 'custom' : 'generic'
      const category = typeof v.category === 'string' && v.category.trim() ? v.category.trim() : undefined
      const previewUrl = typeof v.preview_url === 'string' && v.preview_url.trim() ? v.preview_url.trim() : undefined
      return {
        voice_id: voiceId,
        name,
        source,
        ...(category ? { category } : {}),
        ...(previewUrl ? { preview_url: previewUrl } : {}),
      } satisfies ElevenLabsVoiceOption
    })
    .filter((voice): voice is ElevenLabsVoiceOption => voice !== null)
}

function normalizeResponse(text: string): { voices: ElevenLabsVoiceOption[]; warning: string | null } {
  const parsed = JSON.parse(text) as unknown
  const obj = parsed && typeof parsed === 'object' ? parsed as Partial<ElevenLabsVoiceListResponse> : {}
  const warning = typeof obj.warning === 'string' && obj.warning.trim() ? obj.warning.trim() : null
  return { voices: normalizeVoices(parsed), warning }
}

export function useElevenLabsVoices(
  callTool: UseMcpResult['callTool'],
  state: UseMcpResult['state'],
): UseElevenLabsVoicesResult {
  const [voices, setVoices] = useState<ElevenLabsVoiceOption[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const inFlightRef = useRef<Promise<void> | null>(null)

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return inFlightRef.current
    const run = (async () => {
      if (state !== 'ready') {
        setError('MCP connection is not ready')
        return
      }
      setLoading(true)
      setError(null)
      try {
        const result = await callTool('list_elevenlabs_voices', {})
        const content = result.content as Array<{ type: string; text: string }> | undefined
        const text = content?.[0]?.text
        if (result.isError) {
          setError(text ?? 'list_elevenlabs_voices failed')
          return
        }
        if (!text) {
          setError('list_elevenlabs_voices returned no data')
          return
        }
        const parsed = normalizeResponse(text)
        setVoices(parsed.voices)
        setWarning(parsed.warning)
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
  }, [callTool, state])

  const ensureLoaded = useCallback(async () => {
    if (loaded || loading) return
    await refresh()
  }, [loaded, loading, refresh])

  const customVoices = useMemo(() => voices.filter((voice) => voice.source === 'custom'), [voices])
  const genericVoices = useMemo(() => voices.filter((voice) => voice.source === 'generic'), [voices])

  return { voices, customVoices, genericVoices, loading, loaded, error, warning, refresh, ensureLoaded }
}

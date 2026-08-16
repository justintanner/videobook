import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GENERIC_FALLBACK_VOICES,
  listElevenLabsVoices,
} from '../../server/src/tools/list-elevenlabs-voices.js'
import {
  createElevenLabsVoiceCatalogLifecycle,
  fetchElevenLabsVoiceCatalog,
  parseSpeakVoiceCatalog,
} from '../../src/videobook/use-elevenlabs-voices'
import type { ElevenLabsVoiceCatalog } from '../../src/videobook/use-elevenlabs-voices'

function voiceCatalog(voiceId: string): ElevenLabsVoiceCatalog {
  return {
    voices: [{ voiceId, name: voiceId, source: 'generic' }],
    status: 'live',
    warning: null,
  }
}

function deferred<Value>() {
  let resolve: (value: Value | PromiseLike<Value>) => void = () => undefined
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('useElevenLabsVoices catalog', () => {
  const originalApiKey = process.env.ELEVENLABS_API_KEY
  const originalCustomVoiceIds = process.env.ELEVENLABS_CUSTOM_VOICE_IDS
  const originalCustomVoices = process.env.ELEVENLABS_CUSTOM_VOICES

  beforeEach(() => {
    delete process.env.ELEVENLABS_API_KEY
    delete process.env.ELEVENLABS_CUSTOM_VOICE_IDS
    delete process.env.ELEVENLABS_CUSTOM_VOICES
  })

  afterEach(() => {
    if (originalApiKey) process.env.ELEVENLABS_API_KEY = originalApiKey
    else delete process.env.ELEVENLABS_API_KEY
    if (originalCustomVoiceIds) process.env.ELEVENLABS_CUSTOM_VOICE_IDS = originalCustomVoiceIds
    else delete process.env.ELEVENLABS_CUSTOM_VOICE_IDS
    if (originalCustomVoices) process.env.ELEVENLABS_CUSTOM_VOICES = originalCustomVoices
    else delete process.env.ELEVENLABS_CUSTOM_VOICES
  })

  it('parses the real list_elevenlabs_voices fallback catalog', async () => {
    const payload = await listElevenLabsVoices()
    const catalog = parseSpeakVoiceCatalog(payload)

    expect(payload.status).toBe('fallback')
    expect(catalog.status).toBe('fallback')
    expect(catalog.warning).toMatch(/ELEVENLABS_API_KEY/)
    expect(catalog.voices.map((voice) => voice.voiceId)).toEqual(
      GENERIC_FALLBACK_VOICES.map((voice) => voice.voice_id),
    )
    expect(catalog.voices.map((voice) => voice.name)).toEqual(
      GENERIC_FALLBACK_VOICES.map((voice) => voice.name),
    )
    expect(catalog.voices.every((voice) => voice.source === 'generic')).toBe(true)
  })

  it('loads the fallback catalog through the shipped fetch helper', async () => {
    const catalog = await fetchElevenLabsVoiceCatalog(async (tool, args, options) => {
      expect(tool).toBe('list_elevenlabs_voices')
      expect(args).toEqual({})
      expect(options?.background).toBe(true)
      return listElevenLabsVoices()
    })

    expect(catalog.status).toBe('fallback')
    expect(catalog.voices).toHaveLength(GENERIC_FALLBACK_VOICES.length)
    expect(catalog.voices[0]).toMatchObject({
      voiceId: GENERIC_FALLBACK_VOICES[0]!.voice_id,
      name: GENERIC_FALLBACK_VOICES[0]!.name,
      source: 'generic',
    })
  })
})

describe('ElevenLabs voice catalog lifecycle', () => {
  it('retries after a failed load', async () => {
    let calls = 0
    const lifecycle = createElevenLabsVoiceCatalogLifecycle({
      ready: true,
      load: async () => {
        calls += 1
        if (calls === 1) throw new Error('Voice request failed')
        return voiceCatalog('voice-after-retry')
      },
    })

    expect(await lifecycle.ensureLoaded()).toBeNull()
    expect(lifecycle.getSnapshot()).toMatchObject({
      voices: [],
      loading: false,
      error: 'Voice request failed',
    })

    expect(await lifecycle.ensureLoaded()).toEqual(
      voiceCatalog('voice-after-retry'),
    )
    expect(calls).toBe(2)
    expect(lifecycle.getSnapshot().error).toBeNull()
  })

  it('resets on disconnect and loads again after reconnect', async () => {
    let initialCalls = 0
    let reconnectCalls = 0
    const initialLoad = async () => {
      initialCalls += 1
      return voiceCatalog('voice-before-disconnect')
    }
    const lifecycle = createElevenLabsVoiceCatalogLifecycle({
      ready: true,
      load: initialLoad,
    })

    await lifecycle.ensureLoaded()
    lifecycle.configure({ ready: false, load: initialLoad })

    expect(lifecycle.getSnapshot()).toMatchObject({
      voices: [],
      loading: false,
      error: null,
    })
    expect(await lifecycle.ensureLoaded()).toBeNull()

    lifecycle.configure({
      ready: true,
      load: async () => {
        reconnectCalls += 1
        return voiceCatalog('voice-after-reconnect')
      },
    })

    expect(await lifecycle.ensureLoaded()).toEqual(
      voiceCatalog('voice-after-reconnect'),
    )
    expect(initialCalls).toBe(1)
    expect(reconnectCalls).toBe(1)
  })

  it('reloads an existing catalog on manual refresh', async () => {
    let calls = 0
    const lifecycle = createElevenLabsVoiceCatalogLifecycle({
      ready: true,
      load: async () => {
        calls += 1
        return voiceCatalog(`voice-${calls}`)
      },
    })

    expect(await lifecycle.ensureLoaded()).toEqual(voiceCatalog('voice-1'))
    expect(await lifecycle.refresh()).toEqual(voiceCatalog('voice-2'))
    expect(calls).toBe(2)
    expect(lifecycle.getSnapshot().voices[0]?.voiceId).toBe('voice-2')
  })

  it('deduplicates concurrent ensure and refresh requests', async () => {
    let calls = 0
    const pending = deferred<ElevenLabsVoiceCatalog>()
    const lifecycle = createElevenLabsVoiceCatalogLifecycle({
      ready: true,
      load: () => {
        calls += 1
        return pending.promise
      },
    })

    const first = lifecycle.ensureLoaded()
    const second = lifecycle.ensureLoaded()
    const refresh = lifecycle.refresh()
    await Promise.resolve()

    expect(first).toBe(second)
    expect(second).toBe(refresh)
    expect(calls).toBe(1)

    pending.resolve(voiceCatalog('voice-shared'))
    await expect(first).resolves.toEqual(voiceCatalog('voice-shared'))
  })

  it('ignores a stale request after the connection changes', async () => {
    const pending = deferred<ElevenLabsVoiceCatalog>()
    const initialLoad = () => pending.promise
    const lifecycle = createElevenLabsVoiceCatalogLifecycle({
      ready: true,
      load: initialLoad,
    })
    const stale = lifecycle.ensureLoaded()
    await Promise.resolve()

    lifecycle.configure({ ready: false, load: initialLoad })
    lifecycle.configure({
      ready: true,
      load: async () => voiceCatalog('voice-current'),
    })
    await lifecycle.ensureLoaded()

    pending.resolve(voiceCatalog('voice-stale'))

    await expect(stale).resolves.toBeNull()
    expect(lifecycle.getSnapshot().voices[0]?.voiceId).toBe('voice-current')
  })
})

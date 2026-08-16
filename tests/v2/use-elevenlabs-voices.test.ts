import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GENERIC_FALLBACK_VOICES,
  listElevenLabsVoices,
} from '../../server/src/tools/list-elevenlabs-voices.js'
import {
  fetchElevenLabsVoiceCatalog,
  parseSpeakVoiceCatalog,
} from '../../src/videobook/use-elevenlabs-voices'

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

import { describe, expect, it } from 'vitest'
import { BUILTIN_SOUND_IDS } from '../../server/src/sound-effects/catalog'
import { renderBuiltinSound } from '../../server/src/sound-effects/synth'
import { encodeWav } from '../../server/src/sound-effects/wav'
import { builtinSoundUrl } from '../../src/videobook/builtin-sound-preview'

describe('built-in sound previews', () => {
  it.each(BUILTIN_SOUND_IDS)('%s reuses one local URL with the exact mixed WAV bytes', async (id) => {
    const url = builtinSoundUrl(id)
    expect(url.startsWith('blob:')).toBe(true)
    expect(builtinSoundUrl(id)).toBe(url)
    expect(builtinSoundUrl(id)).toBe(url)
    const response = await fetch(url)
    expect(response.headers.get('content-type')).toBe('audio/wav')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(encodeWav(renderBuiltinSound(id)))
  })

  it('keeps the sounds in separate cached URLs', () => {
    expect(new Set(BUILTIN_SOUND_IDS.map(builtinSoundUrl)).size).toBe(10)
  })
})

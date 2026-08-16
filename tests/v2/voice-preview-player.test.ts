import { describe, expect, it } from 'vitest'
import {
  createVoicePreviewPlayer,
  type PreviewAudio,
} from '../../src/videobook/voice-preview-player'

class FakeAudio implements PreviewAudio {
  readonly url: string
  paused = true
  playCalls = 0
  pauseCalls = 0
  onended: (() => void) | null = null
  playResult: Promise<void> = Promise.resolve()

  constructor(url: string) {
    this.url = url
  }

  play(): Promise<void> {
    this.playCalls += 1
    this.paused = false
    return this.playResult
  }

  pause(): void {
    this.pauseCalls += 1
    this.paused = true
  }

  end(): void {
    this.onended?.()
  }
}

describe('voice preview player', () => {
  it('toggles, stops, and switches voices on the shared element', () => {
    const created: FakeAudio[] = []
    const player = createVoicePreviewPlayer((url) => {
      const audio = new FakeAudio(url)
      created.push(audio)
      return audio
    })
    const seen: Array<string | null> = []
    player.subscribe((voiceId) => {
      seen.push(voiceId)
    })

    player.toggle('voice-a', 'https://example.test/a.mp3')
    expect(player.playingVoiceId).toBe('voice-a')
    expect(created[0]?.playCalls).toBe(1)
    expect(created[0]?.paused).toBe(false)

    player.toggle('voice-a', 'https://example.test/a.mp3')
    expect(player.playingVoiceId).toBeNull()
    expect(created[0]?.pauseCalls).toBe(1)

    player.toggle('voice-a', 'https://example.test/a.mp3')
    player.toggle('voice-b', 'https://example.test/b.mp3')
    expect(player.playingVoiceId).toBe('voice-b')
    expect(created[1]?.pauseCalls).toBeGreaterThanOrEqual(1)
    expect(created[2]?.playCalls).toBe(1)

    created[2]?.end()
    expect(player.playingVoiceId).toBeNull()

    player.toggle('voice-b', 'https://example.test/b.mp3')
    player.stop()
    expect(player.playingVoiceId).toBeNull()
    expect(seen).toContain('voice-a')
    expect(seen).toContain('voice-b')
    expect(seen.at(-1)).toBeNull()

    player.dispose()
    expect(player.playingVoiceId).toBeNull()
  })

  it('clears the playing voice when play() rejects', async () => {
    const player = createVoicePreviewPlayer((url) => {
      const audio = new FakeAudio(url)
      audio.playResult = Promise.reject(new Error('autoplay blocked'))
      return audio
    })

    player.toggle('voice-a', 'https://example.test/a.mp3')
    await Promise.resolve()
    await Promise.resolve()
    expect(player.playingVoiceId).toBeNull()
    player.dispose()
  })
})

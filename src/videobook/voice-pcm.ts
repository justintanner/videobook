import captureUrl from './voice-capture-worklet.js?url'
import type { VoiceSessionDescriptor } from '../../server/src/voice-contract'

interface PcmOptions {
  context: AudioContext
  microphone: MediaStream
  output: GainNode
  sampleRate: number
  onStarted: (responseId: string) => void
  onFinished: (responseId: string) => void
  onError: (message: string) => void
}

interface PlayingItem {
  responseId: string
  itemId: string
  startAt: number
  duration: number
}

export class VoicePcm {
  private socket: WebSocket | null = null
  private capture: AudioWorkletNode | null = null
  private input: MediaStreamAudioSourceNode | null = null
  private mute: GainNode | null = null
  private stopped = false
  private nextAt = 0
  private sources = new Set<AudioBufferSourceNode>()
  private timers = new Set<number>()
  private items: PlayingItem[] = []
  private completed = new Set<string>()
  private interrupted = new Set<string>()
  private rejectStart: ((error: Error) => void) | null = null
  private options: PcmOptions

  constructor(options: PcmOptions) { this.options = options }

  async start(session: VoiceSessionDescriptor, signal: AbortSignal) {
    if (signal.aborted) throw new Error('Voice start cancelled.')
    const url = new URL(`/api/voice/${session.id}/audio`, window.location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    this.socket = socket
    const abort = () => this.stop()
    signal.addEventListener('abort', abort, { once: true })
    try {
      await new Promise<void>((resolve, reject) => {
        this.rejectStart = reject
        socket.addEventListener('open', () => { if (!this.stopped) socket.send(JSON.stringify({ type: 'authenticate', token: session.token })) })
        socket.addEventListener('message', event => {
          try {
            const message = JSON.parse(String(event.data)) as { type?: string }
            if (message.type !== 'ready') throw new Error('Unexpected audio response')
            this.rejectStart = null
            resolve()
          } catch { this.fail('Voice audio could not authenticate. Start voice again.') }
        })
        socket.addEventListener('error', () => this.fail('Voice audio connection failed. Start voice again.'))
        socket.addEventListener('close', () => { if (!this.stopped) this.fail('Voice audio connection ended. Start voice to reconnect.') })
      })
      if (this.stopped) return
      const { context, microphone } = this.options
      await context.audioWorklet.addModule(captureUrl)
      if (this.stopped) return
      this.capture = new AudioWorkletNode(context, 'videobook-voice-capture')
      this.capture.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (this.stopped || socket.readyState !== WebSocket.OPEN) return
        if (socket.bufferedAmount > context.sampleRate * 4) { this.fail('Voice audio connection is too slow. Start voice to reconnect.'); return }
        socket.send(event.data)
      }
      this.input = context.createMediaStreamSource(microphone)
      this.mute = context.createGain()
      this.mute.gain.value = 0
      this.input.connect(this.capture)
      this.capture.connect(this.mute)
      this.mute.connect(context.destination)
    } finally { signal.removeEventListener('abort', abort) }
  }

  enqueue(audio: string, responseId: string, itemId: string) {
    if (this.stopped || this.interrupted.has(responseId)) return
    const { context, output, sampleRate } = this.options
    if (audio.length > 256_000 || this.nextAt - context.currentTime > 30) throw new Error('Voice audio exceeded its buffer limit.')
    const bytes = Uint8Array.from(atob(audio), character => character.charCodeAt(0))
    if (bytes.length === 0 || bytes.length % 2 !== 0) throw new Error('Voice sent an invalid audio frame.')
    const view = new DataView(bytes.buffer)
    const buffer = context.createBuffer(1, bytes.length / 2, sampleRate)
    const samples = buffer.getChannelData(0)
    for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true) / 32768
    const startAt = Math.max(context.currentTime + .015, this.nextAt)
    this.nextAt = startAt + buffer.duration
    let item = this.items.find(value => value.itemId === itemId)
    if (!item) {
      item = { responseId, itemId, startAt, duration: 0 }
      this.items.push(item)
      const timer = window.setTimeout(() => {
        this.timers.delete(timer)
        if (!this.stopped) this.options.onStarted(responseId)
      }, Math.max(0, (startAt - context.currentTime) * 1000))
      this.timers.add(timer)
    }
    item.duration += buffer.duration
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(output)
    this.sources.add(source)
    source.onended = () => {
      source.disconnect()
      this.sources.delete(source)
      if (!this.stopped && this.sources.size === 0 && this.completed.has(responseId)) {
        this.options.onFinished(responseId)
        this.items = []
        this.completed.clear()
      }
    }
    source.start(startAt)
  }

  finish(responseId: string) {
    if (this.stopped || this.interrupted.has(responseId)) return
    this.completed.add(responseId)
    if (this.sources.size === 0) {
      this.options.onFinished(responseId)
      this.items = []
      this.completed.clear()
    }
  }

  interrupt() {
    const now = this.options.context.currentTime
    const item = this.items.find(value => value.startAt + value.duration > now) ?? this.items.at(-1)
    const heard = item ? { responseId: item.responseId, itemId: item.itemId, audioEndMs: Math.floor(Math.max(0, Math.min(item.duration, now - item.startAt)) * 1000) } : undefined
    for (const value of this.items) this.interrupted.add(value.responseId)
    this.clear()
    return heard
  }

  private clear() {
    for (const timer of this.timers) window.clearTimeout(timer)
    this.timers.clear()
    for (const source of this.sources) { source.onended = null; source.stop(); source.disconnect() }
    this.sources.clear()
    this.items = []
    this.completed.clear()
    this.nextAt = this.options.context.currentTime
  }

  private fail(message: string) {
    if (this.stopped) return
    this.rejectStart?.(new Error(message))
    this.rejectStart = null
    this.options.onError(message)
    this.stop()
  }

  stop() {
    if (this.stopped) return
    this.stopped = true
    this.rejectStart?.(new Error('Voice start cancelled.'))
    this.rejectStart = null
    this.socket?.close()
    this.capture?.port.close()
    this.capture?.disconnect()
    this.input?.disconnect()
    this.mute?.disconnect()
    this.clear()
  }
}

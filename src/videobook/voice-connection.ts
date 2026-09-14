import type { VoiceCaption, VoiceOutcome, VoicePhase, VoiceSessionDescriptor, VoiceSessionEvent } from '../../server/src/voice-contract'

interface VoiceConnectionOptions {
  bookId: string
  notebookId?: string
  onPhase: (phase: VoicePhase, message?: string) => void
  onCaption: (caption: VoiceCaption) => void
  onAction: (event: Extract<VoiceSessionEvent, { type: 'action' }>) => Promise<VoiceOutcome>
  onLevel: (level: number) => void
  onPlaybackBlocked: (blocked: boolean) => void
}

function microphoneError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return 'Microphone access is blocked. Allow it in your browser, then start voice again.'
    if (error.name === 'NotFoundError') return 'No microphone found. Connect one, then start voice again.'
    if (error.name === 'NotReadableError') return 'The microphone is busy or unavailable. Check your audio device, then try again.'
  }
  return error instanceof Error ? error.message : 'Voice could not connect. Try again.'
}

export class VoiceConnection {
  private abort = new AbortController()
  private peer: RTCPeerConnection | null = null
  private microphone: MediaStream | null = null
  private channel: RTCDataChannel | null = null
  private context: AudioContext | null = null
  private remoteAudio: HTMLAudioElement | null = null
  private output: GainNode | null = null
  private inputMeter: AnalyserNode | null = null
  private outputMeter: AnalyserNode | null = null
  private descriptor: VoiceSessionDescriptor | null = null
  private stopped = false
  private frame = 0
  private deadline = 0
  private playing = false
  private awaitingAudio = false
  private awaitingSilence = false
  private lastMicrophoneSignalAt = 0
  private outputResponseId: string | null = null
  private review: string | null = null
  private actions = new Set<string>()
  private captionStarts = new Set<string>()
  private outcomes = Promise.resolve()
  private phase: VoicePhase = 'connecting'
  private cleanupListeners: Array<() => void> = []

  private options: VoiceConnectionOptions

  constructor(options: VoiceConnectionOptions) { this.options = options }

  private updatePhase(phase: VoicePhase, message?: string) {
    this.phase = phase
    this.options.onPhase(phase, message)
  }

  private mark(stage: string, fields?: Record<string, unknown>) {
    performance.mark('videobook-voice', { detail: { stage, model: this.descriptor?.model, ...fields } })
  }

  private listen(target: EventTarget, name: string, listener: EventListener, capture = false) {
    target.addEventListener(name, listener, capture)
    this.cleanupListeners.push(() => target.removeEventListener(name, listener, capture))
  }

  async start(): Promise<void> {
    try {
      if (this.stopped) return
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection || !window.AudioContext) {
        throw new Error('Voice needs a browser with microphone support on HTTPS or localhost.')
      }
      this.updatePhase('connecting')
      this.mark('connect-start')
      this.deadline = window.setTimeout(() => this.stop('Voice connection timed out. Start voice to retry.', true), 30_000)
      this.context = new AudioContext({ latencyHint: 'interactive' })
      void this.context.resume().then(() => { if (!this.stopped) this.mark('audio-context-running') }).catch(() => { if (!this.stopped) this.options.onPlaybackBlocked(true) })
      this.output = this.context.createGain()
      this.outputMeter = this.context.createAnalyser()
      this.outputMeter.fftSize = 256
      this.output.connect(this.outputMeter)
      this.outputMeter.connect(this.context.destination)
      for (const media of document.querySelectorAll<HTMLMediaElement>('audio, video')) media.pause()
      this.listen(document, 'play', () => this.stop('Comms paused for media playback. Start voice to resume.'), true)
      this.listen(document, 'visibilitychange', () => { if (document.hidden) this.stop('Comms off while the page is hidden.') })
      this.listen(window, 'pagehide', () => this.stop())
      this.listen(window, 'offline', () => this.stop('You are offline. Start voice after reconnecting.', true))
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
      if (this.stopped) { microphone.getTracks().forEach(track => track.stop()); this.mark('microphone-released', { ended: microphone.getTracks().every(track => track.readyState === 'ended') }); return }
      this.microphone = microphone
      const peer = new RTCPeerConnection()
      this.peer = peer
      for (const track of microphone.getAudioTracks()) {
        peer.addTrack(track, microphone)
        this.listen(track, 'ended', () => this.stop('Microphone disconnected. Check the device and start voice again.', true))
      }
      this.inputMeter = this.context.createAnalyser()
      this.inputMeter.fftSize = 256
      this.context.createMediaStreamSource(microphone).connect(this.inputMeter)
      this.listen(peer, 'track', event => {
        if (this.stopped) return
        const track = (event as RTCTrackEvent).track
        this.mark('media-track')
        const stream = new MediaStream([track])
        this.remoteAudio = new Audio()
        this.remoteAudio.muted = true
        this.remoteAudio.srcObject = stream
        void this.remoteAudio.play().catch(() => { if (!this.stopped) this.options.onPlaybackBlocked(true) })
        const source = this.context!.createMediaStreamSource(stream)
        source.connect(this.output!)
        this.options.onPlaybackBlocked(this.context?.state !== 'running')
      })
      this.listen(peer, 'connectionstatechange', () => {
        if (this.stopped) return
        if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected' || peer.connectionState === 'closed') this.stop('Voice connection lost. Start voice to reconnect.', true)
      })
      this.channel = peer.createDataChannel('oai-events')
      this.listen(this.channel, 'message', event => {
        if (this.stopped) return
        try { this.mediaEvent(JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>) }
        catch { this.stop('Voice sent an unreadable event. Start voice again.', true) }
      })
      this.listen(this.channel, 'open', () => {
        if (this.stopped) return
        window.clearTimeout(this.deadline)
        this.mark('connected')
        this.updatePhase('listening')
      })
      this.listen(this.channel, 'close', () => { if (!this.stopped) this.stop('Voice channel closed. Start voice again.', true) })
      this.measure()
      await peer.setLocalDescription(await peer.createOffer())
      if (this.stopped) return
      const response = await fetch('/api/voice', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId: this.options.bookId, notebookId: this.options.notebookId, sdp: peer.localDescription?.sdp }),
        signal: this.abort.signal,
      })
      const result = await response.json() as VoiceSessionDescriptor & { error?: string }
      if (!response.ok) throw new Error(result.error ?? 'Voice could not connect. Try again.')
      this.descriptor = result
      if (this.stopped) { this.releaseSession(); return }
      void this.readEvents(result)
      await peer.setRemoteDescription({ type: 'answer', sdp: result.sdp })
    } catch (error) {
      if (!this.stopped) this.stop(microphoneError(error), true)
    }
  }

  private mediaEvent(event: Record<string, unknown>) {
    if (typeof event.type === 'string' && /audio_buffer\.(started|stopped|cleared)|speech_(started|stopped)/u.test(event.type)) this.mark(event.type)
    if (event.type === 'input_audio_buffer.speech_started') {
      if (this.playing) {
        this.mark('barge-in')
        this.awaitingSilence = true
        if (this.outputResponseId) void this.post('interrupt', { responseId: this.outputResponseId })
      }
      this.playing = false
      this.awaitingAudio = false
      if (this.output) this.output.gain.value = 0
      this.updatePhase(this.review ? 'review' : 'listening')
    } else if (event.type === 'input_audio_buffer.speech_stopped') {
      this.mark('speech-stop', { microphoneSignalEndedAt: this.lastMicrophoneSignalAt })
      this.updatePhase(this.review ? 'review' : 'thinking')
    } else if (event.type === 'output_audio_buffer.started') {
      this.outputResponseId = typeof event.response_id === 'string' ? event.response_id : null
      this.playing = true
      this.awaitingAudio = true
      if (this.output) this.output.gain.value = 1
      this.updatePhase(this.review ? 'review' : 'speaking')
    } else if (event.type === 'output_audio_buffer.stopped' || event.type === 'output_audio_buffer.cleared') {
      if (event.response_id && event.response_id !== this.outputResponseId) return
      this.playing = false
      if (this.output) this.output.gain.value = 0
      this.updatePhase(this.review ? 'review' : 'listening')
    }
  }

  private measure() {
    const input = new Float32Array(256)
    const output = new Float32Array(256)
    const rms = (samples: Float32Array) => Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length)
    const sample = () => {
      if (this.stopped) return
      this.inputMeter?.getFloatTimeDomainData(input)
      this.outputMeter?.getFloatTimeDomainData(output)
      if (rms(input) > .008) this.lastMicrophoneSignalAt = performance.now()
      const level = Math.min(1, Math.max(rms(input), this.playing ? rms(output) : 0) * 5)
      if (this.awaitingAudio && rms(output) > .002 && this.context?.state === 'running') { this.mark('first-audio'); this.awaitingAudio = false }
      if (this.awaitingSilence && rms(output) < .002) { this.mark('local-silence'); this.awaitingSilence = false }
      this.options.onLevel(level)
      this.frame = requestAnimationFrame(sample)
    }
    this.frame = requestAnimationFrame(sample)
  }

  private async readEvents(session: VoiceSessionDescriptor) {
    try {
      const response = await fetch(`/api/voice/${session.id}/events`, { headers: { Authorization: `Bearer ${session.token}` }, signal: this.abort.signal })
      if (!response.ok || !response.body) throw new Error('Voice event connection failed. Start voice again.')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (!this.stopped) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        if (buffer.length > 512_000) throw new Error('Voice event exceeded its size limit.')
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line && !this.stopped) this.receive(JSON.parse(line) as VoiceSessionEvent)
        }
      }
      if (!this.stopped) this.stop('Voice connection ended. Start voice to reconnect.', true)
    } catch (error) {
      if (!this.stopped) this.stop(microphoneError(error), true)
    }
  }

  private receive(event: VoiceSessionEvent) {
    if (event.type === 'caption') {
      if (!this.captionStarts.has(event.caption.id)) {
        this.captionStarts.add(event.caption.id)
        this.mark('caption-first', { role: event.caption.role })
      }
      if (event.caption.final && !event.caption.interrupted) this.mark('caption-final', { role: event.caption.role })
      if (event.caption.interrupted) this.mark('caption-interrupted')
      this.options.onCaption(event.caption)
    }
    else if (event.type === 'error') this.stop(event.message, true)
    else if (event.type === 'closed') this.stop(event.reason)
    else if (event.type === 'activity' && !this.playing) this.updatePhase(this.review ? 'review' : event.phase)
    else if (event.type === 'action' && !this.actions.has(event.callId)) {
      this.actions.add(event.callId)
      void this.action(event)
    }
  }

  private async action(event: Extract<VoiceSessionEvent, { type: 'action' }>) {
    let outcome: VoiceOutcome
    try { outcome = await this.options.onAction(event) }
    catch (error) { outcome = { status: 'failed', message: error instanceof Error ? error.message : 'The action failed.' } }
    if (this.stopped) return
    if (outcome.status === 'review') {
      this.mark('action-review')
      this.review = event.callId
      this.updatePhase('review')
    }
    await this.acknowledge(event.callId, outcome)
  }

  private async post(route: string, body: unknown) {
    const session = this.descriptor
    if (this.stopped || !session) return
    try {
      const response = await fetch(`/api/voice/${session.id}/${route}`, { method: 'POST', headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: this.abort.signal })
      if (!response.ok) throw new Error('Voice could not receive the action outcome. Check the command UI.')
    } catch (error) {
      if (!this.stopped) this.stop(microphoneError(error), true)
    }
  }

  reportOutcome(outcome: VoiceOutcome) {
    if (!this.review) return
    const callId = this.review
    if (outcome.status !== 'review') this.review = null
    void this.acknowledge(callId, outcome)
    this.updatePhase(this.review ? 'review' : this.playing ? 'speaking' : 'listening')
  }

  private acknowledge(callId: string, outcome: VoiceOutcome) {
    this.outcomes = this.outcomes.then(() => this.post('outcome', { callId, outcome }))
    return this.outcomes
  }

  shareTypedTurn(userText: string, assistantText: string) {
    void this.post('context', { userText: userText.slice(0, 8000), assistantText: assistantText.slice(0, 4000) })
  }

  async resumePlayback() {
    if (this.stopped || !this.context) return
    try {
      await this.context.resume()
      await this.remoteAudio?.play()
      if (!this.stopped) this.options.onPlaybackBlocked(this.context.state !== 'running')
    } catch { if (!this.stopped) this.options.onPlaybackBlocked(true) }
  }

  private releaseSession() {
    const session = this.descriptor
    this.descriptor = null
    if (session) void fetch(`/api/voice/${session.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ interruptedResponseId: this.playing ? this.outputResponseId : null }), keepalive: true }).catch(() => undefined)
  }

  stop(message = 'Comms off.', error = false) {
    if (this.stopped) return
    this.stopped = true
    this.output?.disconnect()
    this.remoteAudio?.pause()
    if (this.remoteAudio) this.remoteAudio.srcObject = null
    this.microphone?.getTracks().forEach(track => track.stop())
    this.mark('microphone-released', { ended: this.microphone?.getTracks().every(track => track.readyState === 'ended') ?? true })
    this.microphone = null
    this.mark('stopped')
    cancelAnimationFrame(this.frame)
    window.clearTimeout(this.deadline)
    this.cleanupListeners.splice(0).forEach(cleanup => cleanup())
    this.abort.abort()
    this.channel?.close()
    this.peer?.getReceivers().forEach(receiver => receiver.track.stop())
    this.peer?.close()
    void this.context?.close().catch(() => undefined)
    this.options.onLevel(0)
    this.options.onPlaybackBlocked(false)
    this.releaseSession()
    this.updatePhase(error ? 'error' : 'off', message)
  }

  get active() { return !this.stopped && this.phase !== 'off' && this.phase !== 'error' }
}

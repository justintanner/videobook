import type { VoiceCaption, VoiceMode, VoiceOutcome, VoicePhase, VoiceProvider, VoiceReviewCommand, VoiceSessionDescriptor, VoiceSessionEvent } from '../../server/src/voice-contract'
import { VoicePcm } from './voice-pcm'
import { VoiceTimeline } from './voice-timeline'
import captureUrl from './voice-capture-worklet.js?url'

interface VoiceConnectionOptions {
  bookId: string
  notebookId?: string
  mode: VoiceMode
  onProvider: (provider: VoiceProvider, fallbackReason?: string) => void
  onPhase: (phase: VoicePhase, message?: string) => void
  onRetrying?: (retrying: boolean) => void
  onCaption: (caption: VoiceCaption) => void
  onAction: (event: Extract<VoiceSessionEvent, { type: 'action' }>) => Promise<VoiceOutcome>
  onReviewCommand: (command: VoiceReviewCommand) => Promise<VoiceOutcome>
  onLevel: (level: number) => void
  onPlaybackBlocked: (blocked: boolean) => void
}

export function voiceNeedsWebRtcOffer(mode: VoiceMode): boolean {
  return mode !== 'xai'
}

export function createVoiceSessionRequest(input: {
  bookId: string
  notebookId?: string
  mode: VoiceMode
  sampleRate: number
  sdp?: string
}): { url: string; body: Record<string, unknown> } {
  const body: Record<string, unknown> = {
    bookId: input.bookId,
    mode: input.mode,
    sampleRate: input.sampleRate,
  }
  if (input.notebookId) body.notebookId = input.notebookId
  if (voiceNeedsWebRtcOffer(input.mode) && input.sdp) body.sdp = input.sdp
  return { url: '/api/voice', body }
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
  private pcm: VoicePcm | null = null
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
  private timeline = new VoiceTimeline()

  private options: VoiceConnectionOptions

  constructor(options: VoiceConnectionOptions) { this.options = options }

  private updatePhase(phase: VoicePhase, message?: string) {
    this.phase = phase
    this.options.onPhase(phase, message)
  }

  private mark(stage: string, fields?: Record<string, unknown>) {
    this.timeline.mark(stage, { model: this.descriptor?.model, ...fields })
  }

  private listen(target: EventTarget, name: string, listener: EventListener, capture = false) {
    target.addEventListener(name, listener, capture)
    this.cleanupListeners.push(() => target.removeEventListener(name, listener, capture))
  }

  async start(): Promise<void> {
    let abandonMicrophone: (() => void) | undefined
    try {
      if (this.stopped) return
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection || !window.AudioContext) {
        throw new Error('Voice needs a browser with microphone support on HTTPS or localhost.')
      }
      this.updatePhase('connecting', 'Connecting voice')
      this.timeline.connectStart()
      this.deadline = window.setTimeout(() => this.stop('Voice connection timed out. Start voice to retry.', true), this.options.mode === 'auto' ? 80_000 : 30_000)
      this.timeline.permissionWaitStart()
      this.updatePhase('connecting', 'Allow microphone access')
      const microphonePromise = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }).finally(() => {
        this.timeline.permissionWaitEnd()
      })
      abandonMicrophone = () => {
        void microphonePromise.then((stream) => {
          if (this.microphone === stream) return
          stream.getTracks().forEach((track) => track.stop())
        }).catch(() => undefined)
      }
      this.context = new AudioContext({ latencyHint: 'interactive', sampleRate: 48_000 })
      void this.context.resume().then(() => { if (!this.stopped) this.mark('audio-context-running') }).catch(() => { if (!this.stopped) this.options.onPlaybackBlocked(true) })
      this.output = this.context.createGain()
      this.outputMeter = this.context.createAnalyser()
      this.outputMeter.fftSize = 256
      this.output.connect(this.outputMeter)
      this.outputMeter.connect(this.context.destination)
      for (const media of document.querySelectorAll<HTMLMediaElement>('audio, video')) media.pause()
      this.installAmbientListeners()
      void this.context.audioWorklet.addModule(captureUrl).catch(() => undefined)
      const skipOffer = !voiceNeedsWebRtcOffer(this.options.mode)
      if (skipOffer) this.timeline.sessionRequest()
      const sessionPromise = skipOffer ? this.requestSession() : null
      const microphone = await microphonePromise
      if (this.stopped) { microphone.getTracks().forEach(track => track.stop()); this.mark('microphone-released', { ended: microphone.getTracks().every(track => track.readyState === 'ended') }); return }
      this.microphone = microphone
      this.updatePhase('connecting', 'Connecting voice')
      this.bindMicrophone(microphone)
      this.measure()
      if (skipOffer) {
        const result = await sessionPromise
        if (!result) return
        if (result.transport !== 'pcm') throw new Error('Voice returned a WebRTC session for an xAI request.')
        await this.acceptPcm(result, microphone)
        return
      }
      await this.startWebRtc(microphone)
    } catch (error) {
      abandonMicrophone?.()
      if (!this.stopped) this.stop(microphoneError(error), true)
    }
  }

  private installAmbientListeners() {
    this.listen(document, 'play', () => this.stop('Comms paused for media playback. Start voice to resume.'), true)
    this.listen(document, 'visibilitychange', () => { if (document.hidden) this.stop('Comms off while the page is hidden.') })
    this.listen(window, 'pagehide', () => this.stop())
    this.listen(window, 'offline', () => this.stop('You are offline. Start voice after reconnecting.', true))
  }

  private bindMicrophone(microphone: MediaStream) {
    for (const track of microphone.getAudioTracks()) {
      this.listen(track, 'ended', () => this.stop('Microphone disconnected. Check the device and start voice again.', true))
    }
    this.inputMeter = this.context!.createAnalyser()
    this.inputMeter.fftSize = 256
    this.context!.createMediaStreamSource(microphone).connect(this.inputMeter)
  }

  private async requestSession(sdp?: string): Promise<VoiceSessionDescriptor | null> {
    const { url, body } = createVoiceSessionRequest({
      bookId: this.options.bookId,
      notebookId: this.options.notebookId,
      mode: this.options.mode,
      sampleRate: this.context!.sampleRate,
      sdp,
    })
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: this.abort.signal,
    })
    const result = await response.json() as VoiceSessionDescriptor & { error?: string }
    if (!response.ok) throw new Error(result.error ?? 'Voice could not connect. Try again.')
    this.descriptor = result
    this.timeline.providerReady({
      provider: result.provider,
      transport: result.transport,
      model: result.model,
      fallbackReason: result.fallbackReason,
    })
    if (this.stopped) { this.releaseSession(); return null }
    this.options.onProvider(result.provider, result.fallbackReason)
    return result
  }

  private async acceptPcm(
    result: Extract<VoiceSessionDescriptor, { transport: 'pcm' }>,
    microphone: MediaStream,
  ) {
    this.pcm = new VoicePcm({
      context: this.context!, microphone, output: this.output!, sampleRate: result.sampleRate,
      onStarted: responseId => this.mediaEvent({ type: 'output_audio_buffer.started', response_id: responseId }),
      onFinished: responseId => this.mediaEvent({ type: 'output_audio_buffer.stopped', response_id: responseId }),
      onError: message => this.stop(message, true),
    })
    void this.readEvents(result)
    await this.pcm.start(result, this.abort.signal)
    if (!this.stopped) this.connected()
  }

  private connected() {
    window.clearTimeout(this.deadline)
    this.mark('connected')
    this.timeline.mediaReady()
    this.updatePhase('listening')
    void this.post('ready', {})
  }

  private async startWebRtc(microphone: MediaStream) {
    const peer = new RTCPeerConnection()
    this.peer = peer
    for (const track of microphone.getAudioTracks()) peer.addTrack(track, microphone)
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
      this.connected()
    })
    this.listen(this.channel, 'close', () => { if (!this.stopped) this.stop('Voice channel closed. Start voice again.', true) })
    await peer.setLocalDescription(await peer.createOffer())
    if (this.stopped) return
    this.timeline.sessionRequest()
    const result = await this.requestSession(peer.localDescription?.sdp)
    if (!result) return
    if (result.transport === 'pcm') {
      this.cleanupListeners.splice(0).forEach(cleanup => cleanup())
      this.channel?.close()
      this.peer?.close()
      this.channel = null
      this.peer = null
      this.installAmbientListeners()
      this.bindMicrophone(microphone)
      await this.acceptPcm(result, microphone)
      return
    }
    void this.readEvents(result)
    await peer.setRemoteDescription({ type: 'answer', sdp: result.sdp })
  }

  private mediaEvent(event: Record<string, unknown>) {
    if (typeof event.type === 'string' && /audio_buffer\.(started|stopped|cleared)|speech_(started|stopped)/u.test(event.type)) this.mark(event.type)
    if (event.type === 'input_audio_buffer.speech_started') {
      const heard = this.pcm?.interrupt()
      if (heard) void this.post('interrupt', heard)
      if (this.playing) {
        this.mark('barge-in')
        this.awaitingSilence = true
        if (this.outputResponseId && !heard) void this.post('interrupt', { responseId: this.outputResponseId })
      }
      this.playing = false
      this.awaitingAudio = false
      if (this.output) this.output.gain.value = 0
      this.options.onRetrying?.(false)
      this.updatePhase(this.review ? 'review' : 'listening')
    } else if (event.type === 'input_audio_buffer.speech_stopped') {
      this.mark('speech-stop', { microphoneSignalEndedAt: this.lastMicrophoneSignalAt })
      this.timeline.turnDetection(this.lastMicrophoneSignalAt)
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
      if (this.awaitingAudio && rms(output) > .002 && this.context?.state === 'running') {
        this.timeline.firstDecodedAudio(this.lastMicrophoneSignalAt)
        this.awaitingAudio = false
      }
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
    else if (event.type === 'audio') this.pcm?.enqueue(event.audio, event.responseId, event.itemId)
    else if (event.type === 'audio-done') this.pcm?.finish(event.responseId)
    else if (event.type === 'activity') {
      if (event.interrupt) this.mediaEvent({ type: 'input_audio_buffer.speech_started' })
      else if (this.pcm && event.phase === 'thinking') this.mediaEvent({ type: 'input_audio_buffer.speech_stopped' })
      this.options.onRetrying?.(Boolean(event.retry))
      if (!this.playing) this.updatePhase(this.review ? 'review' : event.phase)
    }
    else if (event.type === 'action' && !this.actions.has(event.callId)) {
      this.actions.add(event.callId)
      void this.action(event)
    }
    else if (event.type === 'review' && !this.actions.has(event.callId)) {
      this.actions.add(event.callId)
      void this.reviewCommand(event)
    }
  }

  // A spoken decision about the review already on screen. Applying or
  // cancelling also reports the outcome for the original action, so the phase
  // follows whether the review survived rather than this call's own id.
  private async reviewCommand(event: Extract<VoiceSessionEvent, { type: 'review' }>) {
    let outcome: VoiceOutcome
    try { outcome = await this.options.onReviewCommand(event.command) }
    catch (error) { outcome = { status: 'failed', message: error instanceof Error ? error.message : 'The review command failed.' } }
    if (this.stopped) return
    if (outcome.status !== 'review') this.review = null
    this.updatePhase(this.review ? 'review' : this.playing ? 'speaking' : 'listening')
    await this.acknowledge(event.callId, outcome)
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
    this.timeline.acknowledgement(outcome.status)
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
    this.pcm?.stop()
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

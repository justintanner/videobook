class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.frameSize = Math.round(sampleRate / 50)
    this.frame = new ArrayBuffer(this.frameSize * 2)
    this.view = new DataView(this.frame)
    this.offset = 0
  }

  process(inputs) {
    const samples = inputs[0]?.[0]
    if (!samples) return true
    for (const sample of samples) {
      const clamped = Math.max(-1, Math.min(1, sample))
      this.view.setInt16(this.offset * 2, clamped * (clamped < 0 ? 32768 : 32767), true)
      this.offset += 1
      if (this.offset === this.frameSize) {
        this.port.postMessage(this.frame, [this.frame])
        this.frame = new ArrayBuffer(this.frameSize * 2)
        this.view = new DataView(this.frame)
        this.offset = 0
      }
    }
    return true
  }
}

registerProcessor('videobook-voice-capture', VoiceCapture)

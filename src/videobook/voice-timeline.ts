export const VOICE_PERFORMANCE_MARK = 'videobook-voice'

export interface VoiceMark {
  at: number
  stage: string
  model?: string
  role?: string
  durationMs?: number
  permissionWaitMs?: number
  turnDetectionMs?: number
  generationMs?: number
  microphoneSignalEndedAt?: number
  ended?: boolean
  provider?: string
  transport?: string
  reason?: string
  status?: string
  fallbackReason?: string
}

type VoiceMarkFields = Omit<VoiceMark, 'at' | 'stage'>

export class VoiceTimeline {
  private connectAt = 0
  private permissionStartAt = 0
  private permissionEndAt = 0
  private utteranceEndAt = 0
  private turnAt = 0
  private extra: VoiceMarkFields = {}

  setSession(fields: VoiceMarkFields): void {
    this.extra = { ...this.extra, ...fields }
  }

  mark(stage: string, fields?: Record<string, unknown>): void {
    performance.mark(VOICE_PERFORMANCE_MARK, {
      detail: { stage, ...this.extra, ...fields },
    })
  }

  connectStart(): void {
    this.connectAt = performance.now()
    this.mark('connect-start')
  }

  permissionWaitStart(): void {
    this.permissionStartAt = performance.now()
    this.mark('permission-wait-start')
  }

  permissionWaitEnd(): void {
    this.permissionEndAt = performance.now()
    this.mark('permission-wait-end', {
      durationMs: this.permissionEndAt - this.permissionStartAt,
    })
  }

  sessionRequest(): void {
    this.mark('session-request')
  }

  providerReady(fields: {
    provider: string
    transport: string
    model?: string
    fallbackReason?: string
  }): void {
    this.setSession({
      model: fields.model,
      provider: fields.provider,
      transport: fields.transport,
    })
    this.mark('provider-ready', fields)
    if (fields.fallbackReason) this.mark('fallback', { reason: fields.fallbackReason })
  }

  mediaReady(): void {
    const at = performance.now()
    this.mark('media-ready')
    this.mark('connection-setup', {
      durationMs: at - this.connectAt,
      permissionWaitMs: Math.max(0, this.permissionEndAt - this.permissionStartAt),
    })
  }

  turnDetection(microphoneSignalEndedAt?: number): void {
    this.turnAt = performance.now()
    this.utteranceEndAt = microphoneSignalEndedAt && microphoneSignalEndedAt > 0
      ? microphoneSignalEndedAt
      : this.turnAt
    this.mark('turn-detection', { microphoneSignalEndedAt })
  }

  firstDecodedAudio(microphoneSignalEndedAt?: number): void {
    if (this.utteranceEndAt === 0 && microphoneSignalEndedAt && microphoneSignalEndedAt > 0) {
      this.utteranceEndAt = microphoneSignalEndedAt
    }
    const at = performance.now()
    this.mark('first-audio')
    if (this.utteranceEndAt > 0) {
      this.mark('utterance-end-to-decoded-audio', {
        durationMs: at - this.utteranceEndAt,
        turnDetectionMs: this.turnAt > 0 ? this.turnAt - this.utteranceEndAt : undefined,
        generationMs: this.turnAt > 0 ? at - this.turnAt : undefined,
        microphoneSignalEndedAt: this.utteranceEndAt,
      })
    }
  }

  acknowledgement(status?: string): void {
    this.mark('acknowledgement', status ? { status } : undefined)
  }
}

export function voiceMarksFromPerformance(
  entries: readonly PerformanceEntry[] = performance.getEntriesByName(VOICE_PERFORMANCE_MARK),
): VoiceMark[] {
  return entries.map((entry) => {
    const detail = (entry as PerformanceMark).detail as VoiceMarkFields & { stage?: string } | undefined
    return {
      at: entry.startTime,
      ...detail,
      stage: typeof detail?.stage === 'string' ? detail.stage : '',
    }
  })
}

function percentileSummary(values: number[]): {
  sampleCount: number
  p50Ms?: number
  p95Ms?: number
} {
  if (values.length === 0) return { sampleCount: 0 }
  const ordered = [...values].sort((left, right) => left - right)
  return {
    sampleCount: values.length,
    p50Ms: ordered[Math.floor(ordered.length * 0.5)],
    p95Ms: ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * 0.95) - 1))],
  }
}

function numericField(marks: readonly VoiceMark[], field: keyof VoiceMark): number[] {
  return marks.flatMap((mark) => {
    const value = mark[field]
    return typeof value === 'number' && Number.isFinite(value) ? [value] : []
  })
}

export function summarizeVoiceMarks(marks: readonly VoiceMark[]): {
  connectionSetupMs: number | null
  permissionWaitMs: number | null
  utteranceEndToDecodedAudioMs: number[]
  connectionSetup: { sampleCount: number; p50Ms?: number; p95Ms?: number }
  utteranceEndToDecodedAudio: { sampleCount: number; p50Ms?: number; p95Ms?: number }
  stages: Record<string, number>
} {
  const byStage = (stage: string) => marks.filter((mark) => mark.stage === stage)
  const first = (stage: string) => byStage(stage)[0]
  const connection = first('connection-setup')
  const permission = first('permission-wait-end')
  const replies = byStage('utterance-end-to-decoded-audio')
  const stages: Record<string, number> = {}
  for (const mark of marks) {
    if (!(mark.stage in stages)) stages[mark.stage] = mark.at
  }
  return {
    connectionSetupMs: typeof connection?.durationMs === 'number' ? connection.durationMs : null,
    permissionWaitMs: typeof permission?.durationMs === 'number' ? permission.durationMs : null,
    utteranceEndToDecodedAudioMs: numericField(replies, 'durationMs'),
    connectionSetup: percentileSummary(numericField(byStage('connection-setup'), 'durationMs')),
    utteranceEndToDecodedAudio: percentileSummary(numericField(replies, 'durationMs')),
    stages,
  }
}

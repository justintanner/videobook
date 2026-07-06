export type GenerationLifecycleEvent =
  | {
      phase: 'started'
      requestId: string
      category: 'video' | 'image'
      prompt: string
    }
  | {
      phase: 'submitted'
      requestId: string
      assetId: string
    }
  | {
      phase: 'failed'
      requestId: string
    }

export type OnGenerationLifecycle = (event: GenerationLifecycleEvent) => void

export function createGenerationRequestId(category: 'video' | 'image'): string {
  return `pending-${category}-${crypto.randomUUID()}`
}

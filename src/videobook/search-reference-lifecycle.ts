import type {
  ReverseSearchMode,
  SearchReferenceDescriptor,
} from './search-reference'

export type SearchReferenceMode = 'text' | ReverseSearchMode

export type SearchReferenceLifecycleState = {
  mode: SearchReferenceMode
  reference: SearchReferenceDescriptor | null
  startSeconds: string
  durationSeconds: string
  preparing: boolean
  error: string | null
}

export type SearchReferencePreparationResult =
  | {
      status: 'ready'
      mode: ReverseSearchMode
      reference: SearchReferenceDescriptor
    }
  | { status: 'error'; error: string }
  | { status: 'stale' }

type SearchReferenceLifecycleOptions = {
  initialMode?: SearchReferenceMode
  onStateChange: (state: SearchReferenceLifecycleState) => void
  release: (reference: SearchReferenceDescriptor) => Promise<void> | void
}

export type SearchReferenceLifecycle = {
  changeMode: (mode: SearchReferenceMode) => void
  clearError: () => void
  clearReference: () => void
  close: () => void
  getState: () => SearchReferenceLifecycleState
  prepare: (
    mode: ReverseSearchMode,
    createReference: () => Promise<SearchReferenceDescriptor>,
  ) => Promise<SearchReferencePreparationResult>
  resetInvalidRange: (error: unknown) => string
  setDurationSeconds: (value: string) => void
  setStartSeconds: (value: string) => void
  stop: () => void
}

export function initialSearchReferenceLifecycleState(
  mode: SearchReferenceMode = 'text',
): SearchReferenceLifecycleState {
  return {
    mode,
    reference: null,
    startSeconds: '0',
    durationSeconds: '',
    preparing: false,
    error: null,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createSearchReferenceLifecycle({
  initialMode = 'text',
  onStateChange,
  release,
}: SearchReferenceLifecycleOptions): SearchReferenceLifecycle {
  let active = true
  let revision = 0
  let state = initialSearchReferenceLifecycleState(initialMode)

  const publish = (next: SearchReferenceLifecycleState): void => {
    state = next
    if (active) onStateChange(next)
  }

  const releaseReference = (
    reference: SearchReferenceDescriptor | null,
  ): void => {
    if (!reference) return
    void Promise.resolve(release(reference)).catch(() => undefined)
  }

  const reset = (mode: SearchReferenceMode): void => {
    revision += 1
    const previous = state.reference
    publish(initialSearchReferenceLifecycleState(mode))
    releaseReference(previous)
  }

  const changeMode = (mode: SearchReferenceMode): void => {
    if (!active) return
    reset(mode)
  }

  const clearReference = (): void => {
    if (!active) return
    revision += 1
    const previous = state.reference
    publish({
      ...state,
      reference: null,
      startSeconds: '0',
      durationSeconds: '',
      preparing: false,
      error: null,
    })
    releaseReference(previous)
  }

  const prepare = async (
    mode: ReverseSearchMode,
    createReference: () => Promise<SearchReferenceDescriptor>,
  ): Promise<SearchReferencePreparationResult> => {
    if (!active) return { status: 'stale' }
    const preparationRevision = revision + 1
    revision = preparationRevision
    if (state.mode === mode) {
      publish({ ...state, preparing: true, error: null })
    } else {
      const previous = state.reference
      publish({
        ...initialSearchReferenceLifecycleState(mode),
        preparing: true,
      })
      releaseReference(previous)
    }
    try {
      const reference = await createReference()
      if (!active || preparationRevision !== revision) {
        releaseReference(reference)
        return { status: 'stale' }
      }
      const previous = state.reference
      publish({
        mode,
        reference,
        startSeconds: '0',
        durationSeconds: '',
        preparing: false,
        error: null,
      })
      if (previous !== reference) releaseReference(previous)
      return { status: 'ready', mode, reference }
    } catch (error) {
      if (!active || preparationRevision !== revision) {
        return { status: 'stale' }
      }
      const message = errorMessage(error)
      publish({ ...state, preparing: false, error: message })
      return { status: 'error', error: message }
    }
  }

  const resetInvalidRange = (error: unknown): string => {
    const message = errorMessage(error)
    if (active) {
      publish({
        ...state,
        startSeconds: '0',
        durationSeconds: '',
        error: message,
      })
    }
    return message
  }

  const close = (): void => {
    if (!active) return
    reset('text')
  }

  const stop = (): void => {
    if (!active) return
    active = false
    revision += 1
    const previous = state.reference
    state = initialSearchReferenceLifecycleState()
    releaseReference(previous)
  }

  return {
    changeMode,
    clearError: () => {
      if (active && state.error) publish({ ...state, error: null })
    },
    clearReference,
    close,
    getState: () => state,
    prepare,
    resetInvalidRange,
    setDurationSeconds: (value) => {
      if (active) publish({ ...state, durationSeconds: value, error: null })
    },
    setStartSeconds: (value) => {
      if (active) publish({ ...state, startSeconds: value, error: null })
    },
    stop,
  }
}

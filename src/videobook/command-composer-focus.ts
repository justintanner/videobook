import { useLayoutEffect } from 'react'

interface CommandComposerFocusTarget {
  focus: (options?: FocusOptions) => void
}

type FrameScheduler = (callback: FrameRequestCallback) => number

type FocusRequest = {
  epoch: number
  scope: string
  resolve: () => CommandComposerFocusTarget | null
  afterFocus?: () => void
}

type ComposerFocusState = {
  epoch: number
  scope: string
  enabled: boolean
  composerOwnedFocus: boolean
  modality: 'initial' | 'keyboard' | 'pointer' | 'touch'
  pending: FocusRequest | null
  frame: number | null
}

const documentStates = new WeakMap<Document, ComposerFocusState>()
const composerSelector = '.command-composer [aria-label="Videobook command input"]'
const editingSelector = 'input:not([type="file"]), textarea, select, [contenteditable="true"], video[controls], audio[controls]'
const overlaySelector = 'dialog[open], :popover-open, [aria-modal="true"], [role="menu"], details.canvas-add-menu[open]'

function focusState(owner: Document): ComposerFocusState {
  const existing = documentStates.get(owner)
  if (existing) return existing
  const state: ComposerFocusState = {
    epoch: 0,
    scope: '',
    enabled: false,
    composerOwnedFocus: false,
    modality: 'initial',
    pending: null,
    frame: null,
  }
  documentStates.set(owner, state)
  return state
}

function flushFocus(owner: Document, state: ComposerFocusState): void {
  const pending = state.pending
  if (!pending) return
  const target = pending.resolve()
  if (!state.enabled && (!(target instanceof HTMLElement) || target.closest('.command-composer'))) return
  state.pending = null
  if (pending.epoch !== state.epoch || pending.scope !== state.scope) return
  if (!target || owner.visibilityState === 'hidden') return
  if (target instanceof HTMLElement) {
    if (!target.isConnected || target.matches(':disabled, [aria-disabled="true"]') || target.closest('[inert], [hidden]')) return
    const overlay = [...owner.querySelectorAll(overlaySelector)].at(-1)
    if (overlay && !overlay.contains(target)) return
    const active = owner.activeElement
    if (active && active !== target && active.matches(editingSelector) && !active.closest('[hidden], [inert]')) return
    if (
      overlay
      && active instanceof Element
      && overlay.contains(active)
      && !active.closest('.command-composer')
      && active !== target
    ) return
  }
  target.focus({ preventScroll: true })
  pending.afterFocus?.()
}

function scheduleFocus(owner: Document, state: ComposerFocusState): void {
  if (state.frame !== null) owner.defaultView?.cancelAnimationFrame(state.frame)
  state.frame = owner.defaultView?.requestAnimationFrame(() => {
    state.frame = null
    flushFocus(owner, state)
  }) ?? null
}

function queueFocus(owner: Document, state: ComposerFocusState): void {
  state.pending = {
    epoch: state.epoch,
    scope: state.scope,
    resolve: () => owner.querySelector<HTMLElement>(composerSelector),
  }
  scheduleFocus(owner, state)
}

export function captureCommandComposerFocus(
  resolveTarget: () => CommandComposerFocusTarget | null = () =>
    document.querySelector<HTMLElement>(composerSelector),
  afterFocus?: () => void,
): () => void {
  const owner = document
  const state = focusState(owner)
  const request: FocusRequest = {
    epoch: state.epoch,
    scope: state.scope,
    resolve: resolveTarget,
    afterFocus,
  }
  return () => {
    if (state.epoch !== request.epoch || state.scope !== request.scope) return
    state.pending = request
    scheduleFocus(owner, state)
  }
}

export function capturePointerComposerFocus(): () => void {
  return focusState(document).modality === 'pointer'
    ? captureCommandComposerFocus()
    : () => undefined
}

export function captureDismissedComposerFocus(opener: HTMLElement | null): () => void {
  const pointer = focusState(document).modality === 'pointer'
  const fromComposer = Boolean(opener?.closest('.command-composer'))
  return captureCommandComposerFocus(() => {
    const composer = document.querySelector<HTMLElement>(composerSelector)
    if (!(pointer || fromComposer || opener === document.body || !opener?.isConnected) || !composer || composer.closest('[hidden]')) return opener
    return composer.matches('[aria-disabled="true"]')
      ? composer.closest('.command-composer')?.querySelector<HTMLElement>('button[aria-label="Open actions"]:not(:disabled)') ?? null
      : composer
  })
}

export function useCommandComposerFocus(scope: string, enabled: boolean): void {
  useLayoutEffect(() => {
    const owner = document
    const state = focusState(owner)
    const invalidate = () => {
      state.epoch += 1
      state.pending = null
    }
    const pointer = (event: PointerEvent) => {
      invalidate()
      state.modality = event.pointerType === 'touch' ? 'touch' : 'pointer'
    }
    const keyboard = () => {
      invalidate()
      state.modality = 'keyboard'
    }
    const focus = (event: FocusEvent) => {
      const target = event.target
      state.composerOwnedFocus = target instanceof Element && target.matches(composerSelector)
    }
    const click = (event: MouseEvent) => {
      if (event.detail === 0 || state.modality !== 'pointer') return
      const target = event.target
      if (!(target instanceof Element) || target.closest(editingSelector)) return
      if (target.closest('[data-composer-focus]')?.getAttribute('data-composer-focus') !== 'return') return
      queueFocus(owner, state)
    }
    owner.addEventListener('pointerdown', pointer, true)
    owner.addEventListener('keydown', keyboard, true)
    owner.addEventListener('focusin', focus, true)
    owner.addEventListener('click', click, true)
    owner.defaultView?.addEventListener('blur', invalidate)
    return () => {
      invalidate()
      owner.removeEventListener('pointerdown', pointer, true)
      owner.removeEventListener('keydown', keyboard, true)
      owner.removeEventListener('focusin', focus, true)
      owner.removeEventListener('click', click, true)
      owner.defaultView?.removeEventListener('blur', invalidate)
      if (state.frame !== null) owner.defaultView?.cancelAnimationFrame(state.frame)
      state.frame = null
    }
  }, [])

  useLayoutEffect(() => {
    const state = focusState(document)
    const changed = state.scope !== scope
    const becameReady = !state.enabled && enabled
    state.scope = scope
    state.enabled = enabled
    if (changed) state.pending = null
    if (!enabled) return
    if (state.pending) {
      scheduleFocus(document, state)
      return
    }
    if (!(changed || becameReady)) return
    if (becameReady && state.composerOwnedFocus && state.modality !== 'touch' && document.activeElement === document.body) {
      queueFocus(document, state)
      return
    }
    if (state.modality === 'initial' && document.activeElement !== document.body) return
    if (state.modality !== 'initial' && !(changed && state.modality === 'pointer')) return
    if (!window.matchMedia('(pointer: fine)').matches) return
    queueFocus(document, state)
  }, [enabled, scope])
}

function dismissQueuedComposerFocus(): void {
  const state = focusState(document)
  state.epoch += 1
  state.pending = null
}

export function restoreFocusElement(element: HTMLElement | null): void {
  dismissQueuedComposerFocus()
  const label = element?.getAttribute('aria-label')
  const fullscreenTrigger = Boolean(label?.includes('fullscreen'))
  if (fullscreenTrigger) {
    if (element?.isConnected) {
      element.focus()
      return
    }
    if (label) {
      document.querySelector<HTMLElement>(
        `[aria-label="${CSS.escape(label)}"]`,
      )?.focus()
    }
    return
  }
  if (element?.isConnected) {
    element.focus()
    return
  }
  document.querySelector<HTMLElement>(
    '[aria-label="Videobook command input"]',
  )?.focus()
}

export function restoreCommandComposerFocus(
  resolveTarget: () => CommandComposerFocusTarget | null,
  scheduleFrame: FrameScheduler = (callback) => window.requestAnimationFrame(callback),
): void {
  if (typeof document === 'undefined') {
    scheduleFrame(() => resolveTarget()?.focus({ preventScroll: true }))
    return
  }
  captureCommandComposerFocus(resolveTarget)()
}

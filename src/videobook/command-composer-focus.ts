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
const composerSelector = '.command-composer input[aria-label="Videobook command input"]'
const editingSelector = 'input:not([type="file"]), textarea, select, [contenteditable="true"], video[controls], audio[controls]'
const overlaySelector = 'dialog[open], [aria-modal="true"], [role="menu"], details.canvas-add-menu[open]'

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
    if (!target.isConnected || target.matches(':disabled') || target.closest('[inert], [hidden]')) return
    const overlay = owner.querySelector(overlaySelector)
    if (overlay && !overlay.contains(target)) return
    const active = owner.activeElement
    if (active && active !== target && active.matches(editingSelector)) return
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
    resolve: () => owner.querySelector<HTMLInputElement>(composerSelector),
  }
  scheduleFocus(owner, state)
}

export function captureCommandComposerFocus(
  resolveTarget: () => CommandComposerFocusTarget | null = () =>
    document.querySelector<HTMLInputElement>(composerSelector),
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
  const composer = document.querySelector<HTMLInputElement>(composerSelector)
  const pointer = focusState(document).modality === 'pointer'
  return captureCommandComposerFocus(() =>
    pointer && composer && !composer.closest('[hidden]')
      ? composer
      : opener)
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

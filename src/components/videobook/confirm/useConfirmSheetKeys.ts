import { useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from 'react'
import {
  confirmSheetKeyAction,
  type ConfirmSheetKeyTarget,
} from '@/videobook/confirm-sheet-keys'

function keyTarget(target: EventTarget | null): ConfirmSheetKeyTarget | null {
  if (!(target instanceof HTMLElement)) return null
  return {
    tagName: target.tagName,
    type: target instanceof HTMLInputElement ? target.type : null,
  }
}

interface ConfirmSheetKeyHandlers {
  sheetRef: RefObject<HTMLElement | null>
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
}

// On open, focus lands on the first invalid field so a blocked sheet starts
// where the fix is. Rendered after the body inside the same Suspense boundary,
// so a lazily loaded body has mounted by the time this effect runs.
export function ConfirmSheetInitialFocus({
  sheetRef,
}: {
  sheetRef: RefObject<HTMLElement | null>
}) {
  useLayoutEffect(() => {
    const invalid = sheetRef.current?.querySelector<HTMLElement>(
      '[aria-invalid="true"]:not(:disabled)',
    )
    invalid?.focus({ preventScroll: true })
  }, [sheetRef])
  return null
}

// One keyboard model for every sheet: Escape cancels, Cmd/Ctrl+Enter applies
// from anywhere, Enter applies from single-line fields.
export function useConfirmSheetKeys(options: {
  applyFormId: string
  applyDisabled: boolean
  busy: boolean
  onCancel: () => void
}): ConfirmSheetKeyHandlers {
  const sheetRef = useRef<HTMLElement | null>(null)
  const { busy, onCancel } = options

  useLayoutEffect(() => {
    const dismissFromComposer = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || busy) return
      const target = event.target
      if (target !== document.body && (!(target instanceof Element) || !target.closest('.command-composer'))) return
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return
      if (document.querySelector('dialog[open], [aria-modal="true"], [role="menu"], details.canvas-add-menu[open]')) return
      event.preventDefault()
      onCancel()
    }
    document.addEventListener('keydown', dismissFromComposer)
    return () => document.removeEventListener('keydown', dismissFromComposer)
  }, [busy, onCancel])

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const action = confirmSheetKeyAction({
      key: event.key,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      defaultPrevented: event.defaultPrevented,
      target: keyTarget(event.target),
    }, { busy: options.busy })
    if (action === 'none') return
    event.preventDefault()
    event.stopPropagation()
    if (action === 'cancel') {
      options.onCancel()
      return
    }
    if (options.applyDisabled) return
    const form = document.getElementById(options.applyFormId)
    if (form instanceof HTMLFormElement) form.requestSubmit()
  }

  return { sheetRef, onKeyDown }
}

import { describe, expect, it } from 'vitest'
import {
  focusableModalDialogElements,
  handleModalDialogKeyDown,
  modalDialogFocusWrapTarget,
  scheduleModalDialogFocusRestoration,
  shouldDismissModalDialogFromBackdrop,
} from '../../src/videobook/modal-dialog-interactions'

type FakeFocusElement = {
  disabled: boolean
  focusCalls: number
  hidden: boolean
  hiddenAncestor: boolean
  hiddenInput: boolean
  negativeTabIndex: boolean
  closest: () => object | null
  focus: () => void
  getAttribute: (name: string) => string | null
  matches: () => boolean
}

function focusElement(options: Partial<Pick<
  FakeFocusElement,
  'disabled' | 'hidden' | 'hiddenAncestor' | 'hiddenInput' | 'negativeTabIndex'
>> = {}): FakeFocusElement {
  const element: FakeFocusElement = {
    disabled: options.disabled ?? false,
    focusCalls: 0,
    hidden: options.hidden ?? false,
    hiddenAncestor: options.hiddenAncestor ?? false,
    hiddenInput: options.hiddenInput ?? false,
    negativeTabIndex: options.negativeTabIndex ?? false,
    closest: () => element.hiddenAncestor ? {} : null,
    focus: () => {
      element.focusCalls += 1
    },
    getAttribute: (name) => name === 'tabindex' && element.negativeTabIndex ? '-2' : null,
    matches: () => element.disabled || element.hiddenInput,
  }
  return element
}

function container(elements: FakeFocusElement[]): HTMLElement {
  return {
    querySelectorAll: () => elements,
  } as unknown as HTMLElement
}

function keyEvent(key: string, shiftKey = false) {
  let prevented = 0
  return {
    event: {
      key,
      shiftKey,
      preventDefault: () => {
        prevented += 1
      },
    },
    prevented: () => prevented,
  }
}

describe('modal dialog interactions', () => {
  it('selects wrap targets in both directions', () => {
    const first = focusElement()
    const middle = focusElement()
    const last = focusElement()
    const elements = [first, middle, last]

    expect(modalDialogFocusWrapTarget(elements, last, false)).toBe(first)
    expect(modalDialogFocusWrapTarget(elements, first, true)).toBe(last)
    expect(modalDialogFocusWrapTarget(elements, middle, false)).toBeNull()
    expect(modalDialogFocusWrapTarget(elements, {}, false)).toBe(first)
    expect(modalDialogFocusWrapTarget(elements, {}, true)).toBe(last)
  })

  it('ignores disabled, hidden, nested-hidden, and untabbable controls', () => {
    const disabled = focusElement({ disabled: true })
    const hidden = focusElement({ hidden: true })
    const nestedHidden = focusElement({ hiddenAncestor: true })
    const hiddenInput = focusElement({ hiddenInput: true })
    const untabbable = focusElement({ negativeTabIndex: true })
    const available = focusElement()

    expect(focusableModalDialogElements(container([
      disabled,
      hidden,
      nestedHidden,
      hiddenInput,
      untabbable,
      available,
    ]))).toEqual([available])
  })

  it('wraps Tab forward and Shift+Tab backward', () => {
    const first = focusElement()
    const last = focusElement()
    const dialog = container([first, last])
    const forward = keyEvent('Tab')
    const backward = keyEvent('Tab', true)

    handleModalDialogKeyDown(forward.event, {
      activeElement: last as unknown as Element,
      busy: false,
      container: dialog,
      onClose: () => undefined,
    })
    handleModalDialogKeyDown(backward.event, {
      activeElement: first as unknown as Element,
      busy: false,
      container: dialog,
      onClose: () => undefined,
    })

    expect(first.focusCalls).toBe(1)
    expect(last.focusCalls).toBe(1)
    expect(forward.prevented()).toBe(1)
    expect(backward.prevented()).toBe(1)
  })

  it('dismisses on Escape only while idle', () => {
    let closeCalls = 0
    const idle = keyEvent('Escape')
    const busy = keyEvent('Escape')

    handleModalDialogKeyDown(idle.event, {
      busy: false,
      container: null,
      onClose: () => {
        closeCalls += 1
      },
    })
    handleModalDialogKeyDown(busy.event, {
      busy: true,
      container: null,
      onClose: () => {
        closeCalls += 1
      },
    })

    expect(closeCalls).toBe(1)
    expect(idle.prevented()).toBe(1)
    expect(busy.prevented()).toBe(0)
  })

  it('dismisses only idle backdrop presses outside dialog content', () => {
    const backdrop = new EventTarget()
    const content = new EventTarget()

    expect(shouldDismissModalDialogFromBackdrop(backdrop, backdrop, false)).toBe(true)
    expect(shouldDismissModalDialogFromBackdrop(backdrop, content, false)).toBe(false)
    expect(shouldDismissModalDialogFromBackdrop(backdrop, backdrop, true)).toBe(false)
  })

  it('restores focus asynchronously only to connected openers', () => {
    const connected = focusElement() as FakeFocusElement & { isConnected: boolean }
    connected.isConnected = true
    const disconnected = focusElement() as FakeFocusElement & { isConnected: boolean }
    disconnected.isConnected = false
    const scheduled: Array<() => void> = []

    expect(scheduleModalDialogFocusRestoration(
      connected,
      (callback) => scheduled.push(callback),
    )).toBe(true)
    expect(scheduleModalDialogFocusRestoration(
      disconnected,
      (callback) => scheduled.push(callback),
    )).toBe(false)
    expect(scheduled).toHaveLength(1)

    scheduled[0]!()
    expect(connected.focusCalls).toBe(1)
    expect(disconnected.focusCalls).toBe(0)
  })
})

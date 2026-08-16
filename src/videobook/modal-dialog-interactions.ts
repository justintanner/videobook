const focusableElementSelector = [
  'button',
  'input',
  'select',
  'textarea',
  '[href]',
  '[contenteditable="true"]',
  '[tabindex]',
].join(', ')

type ModalDialogKeyEvent = {
  key: string
  shiftKey: boolean
  preventDefault: () => void
}

type RestorableFocusTarget = {
  focus: () => void
  isConnected: boolean
}

function isAvailableFocusTarget(element: HTMLElement): boolean {
  const tabIndex = element.getAttribute('tabindex')
  return !element.hidden
    && !element.matches(':disabled, [type="hidden"]')
    && (tabIndex === null || !Number.isFinite(Number(tabIndex)) || Number(tabIndex) >= 0)
    && element.closest('[hidden], [aria-hidden="true"], [inert]') === null
}

export function focusableModalDialogElements(
  container: HTMLElement,
): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(focusableElementSelector)]
    .filter(isAvailableFocusTarget)
}

export function modalDialogFocusWrapTarget<ElementType>(
  focusable: readonly ElementType[],
  activeElement: unknown,
  backwards: boolean,
): ElementType | null {
  const first = focusable[0]
  const last = focusable.at(-1)
  if (!first || !last) return null
  if (!focusable.includes(activeElement as ElementType)) {
    return backwards ? last : first
  }
  if (backwards && activeElement === first) return last
  if (!backwards && activeElement === last) return first
  return null
}

export function handleModalDialogKeyDown(
  event: ModalDialogKeyEvent,
  options: {
    activeElement?: Element | null
    busy: boolean
    container: HTMLElement | null
    onClose: () => void
  },
): void {
  if (event.key === 'Escape') {
    if (!options.busy) {
      event.preventDefault()
      options.onClose()
    }
    return
  }
  if (event.key !== 'Tab' || !options.container) return
  const focusable = focusableModalDialogElements(options.container)
  const activeElement = options.activeElement === undefined
    ? document.activeElement
    : options.activeElement
  const target = modalDialogFocusWrapTarget(
    focusable,
    activeElement,
    event.shiftKey,
  )
  if (!target) return
  event.preventDefault()
  target.focus()
}

export function shouldDismissModalDialogFromBackdrop(
  currentTarget: EventTarget,
  target: EventTarget,
  busy: boolean,
): boolean {
  return !busy && currentTarget === target
}

export function scheduleModalDialogFocusRestoration(
  target: RestorableFocusTarget | null,
  schedule: (callback: () => void) => void,
): boolean {
  if (!target?.isConnected) return false
  schedule(() => {
    if (target.isConnected) target.focus()
  })
  return true
}

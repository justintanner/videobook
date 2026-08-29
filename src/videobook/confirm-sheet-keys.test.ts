import { describe, expect, it } from 'vitest'
import {
  confirmSheetKeyAction,
  isSingleLineTextTarget,
  type ConfirmSheetKeyEvent,
} from './confirm-sheet-keys'

function key(overrides: Partial<ConfirmSheetKeyEvent>): ConfirmSheetKeyEvent {
  return {
    key: 'Enter',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    defaultPrevented: false,
    target: null,
    ...overrides,
  }
}

describe('confirm sheet keyboard model', () => {
  it('cancels on Escape from anywhere unless the sheet is busy', () => {
    expect(confirmSheetKeyAction(key({ key: 'Escape' }), { busy: false })).toBe('cancel')
    expect(confirmSheetKeyAction(
      key({ key: 'Escape', target: { tagName: 'TEXTAREA' } }),
      { busy: false },
    )).toBe('cancel')
    expect(confirmSheetKeyAction(key({ key: 'Escape' }), { busy: true })).toBe('none')
  })

  it('applies on Cmd/Ctrl+Enter from any control, including textareas', () => {
    expect(confirmSheetKeyAction(
      key({ metaKey: true, target: { tagName: 'TEXTAREA' } }),
      { busy: false },
    )).toBe('apply')
    expect(confirmSheetKeyAction(
      key({ ctrlKey: true, target: { tagName: 'BUTTON' } }),
      { busy: false },
    )).toBe('apply')
    expect(confirmSheetKeyAction(
      key({ metaKey: true, target: { tagName: 'INPUT', type: 'range' } }),
      { busy: false },
    )).toBe('apply')
  })

  it('applies on plain Enter only inside single-line text fields', () => {
    expect(confirmSheetKeyAction(
      key({ target: { tagName: 'INPUT', type: 'text' } }),
      { busy: false },
    )).toBe('apply')
    expect(confirmSheetKeyAction(
      key({ target: { tagName: 'input', type: 'number' } }),
      { busy: false },
    )).toBe('apply')
    expect(confirmSheetKeyAction(
      key({ target: { tagName: 'INPUT', type: 'datetime-local' } }),
      { busy: false },
    )).toBe('apply')
    expect(confirmSheetKeyAction(
      key({ target: { tagName: 'INPUT', type: 'checkbox' } }),
      { busy: false },
    )).toBe('none')
    expect(confirmSheetKeyAction(
      key({ target: { tagName: 'INPUT', type: 'range' } }),
      { busy: false },
    )).toBe('none')
    expect(confirmSheetKeyAction(
      key({ target: { tagName: 'TEXTAREA' } }),
      { busy: false },
    )).toBe('none')
    expect(confirmSheetKeyAction(
      key({ target: { tagName: 'BUTTON' } }),
      { busy: false },
    )).toBe('none')
    expect(confirmSheetKeyAction(
      key({ target: { tagName: 'SELECT' } }),
      { busy: false },
    )).toBe('none')
  })

  it('never applies while busy and ignores Alt+Enter and other keys', () => {
    expect(confirmSheetKeyAction(
      key({ metaKey: true, target: { tagName: 'TEXTAREA' } }),
      { busy: true },
    )).toBe('none')
    expect(confirmSheetKeyAction(
      key({ target: { tagName: 'INPUT', type: 'text' } }),
      { busy: true },
    )).toBe('none')
    expect(confirmSheetKeyAction(key({ altKey: true }), { busy: false })).toBe('none')
    expect(confirmSheetKeyAction(key({ key: 'ArrowLeft' }), { busy: false })).toBe('none')
    expect(confirmSheetKeyAction(key({ key: ' ' }), { busy: false })).toBe('none')
  })

  it('leaves keys a body already consumed alone', () => {
    expect(confirmSheetKeyAction(
      key({ defaultPrevented: true, target: { tagName: 'INPUT', type: 'number' } }),
      { busy: false },
    )).toBe('none')
    expect(confirmSheetKeyAction(
      key({ key: 'Escape', defaultPrevented: true }),
      { busy: false },
    )).toBe('none')
  })

  it('treats an input without a type as a text field', () => {
    expect(isSingleLineTextTarget({ tagName: 'INPUT' })).toBe(true)
    expect(isSingleLineTextTarget({ tagName: 'INPUT', type: null })).toBe(true)
    expect(isSingleLineTextTarget({ tagName: 'DIV' })).toBe(false)
    expect(isSingleLineTextTarget(null)).toBe(false)
  })
})

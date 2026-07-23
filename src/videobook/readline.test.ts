import { describe, expect, it } from 'vitest'
import { applyReadlineEdit } from './readline'

function edit(
  value: string,
  caret: number,
  key: string,
  options: { ctrlKey?: boolean; altKey?: boolean; multiline?: boolean; yankText?: string } = {},
) {
  return applyReadlineEdit({
    value,
    selectionStart: caret,
    selectionEnd: caret,
    key,
    ctrlKey: options.ctrlKey ?? false,
    altKey: options.altKey ?? false,
    multiline: options.multiline ?? true,
    yankText: options.yankText ?? '',
  })
}

describe('applyReadlineEdit', () => {
  it('moves to line boundaries and across characters', () => {
    expect(edit('one\ntwo', 6, 'a', { ctrlKey: true })?.selectionStart).toBe(4)
    expect(edit('one\ntwo', 5, 'e', { ctrlKey: true })?.selectionStart).toBe(7)
    expect(edit('one', 2, 'b', { ctrlKey: true })?.selectionStart).toBe(1)
    expect(edit('one', 2, 'f', { ctrlKey: true })?.selectionStart).toBe(3)
  })

  it('moves by words', () => {
    expect(edit('alpha beta', 10, 'b', { altKey: true })?.selectionStart).toBe(6)
    expect(edit('alpha beta', 0, 'f', { altKey: true })?.selectionStart).toBe(5)
  })

  it('kills and yanks text', () => {
    const killed = edit('alpha beta', 6, 'k', { ctrlKey: true })
    expect(killed).toMatchObject({ value: 'alpha ', killedText: 'beta' })
    expect(edit('alpha ', 6, 'y', {
      ctrlKey: true,
      yankText: killed?.killedText,
    })?.value).toBe('alpha beta')
    expect(edit('alpha beta', 10, 'w', { ctrlKey: true })).toMatchObject({
      value: 'alpha ',
      killedText: 'beta',
    })
  })

  it('moves vertically while preserving the logical column', () => {
    expect(edit('abc\nx\n12345', 11, 'p', {
      ctrlKey: true,
      multiline: true,
    })?.selectionStart).toBe(5)
    expect(edit('abc\nx\n12345', 5, 'n', {
      ctrlKey: true,
      multiline: true,
    })?.selectionStart).toBe(7)
  })

  it('leaves Ctrl-P and Ctrl-N to command history in single-line mode', () => {
    expect(edit('command', 7, 'p', {
      ctrlKey: true,
      multiline: false,
    })).toBeNull()
  })
})

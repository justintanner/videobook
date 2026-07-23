export interface ReadlineEdit {
  value: string
  selectionStart: number
  selectionEnd: number
  killedText?: string
}

export interface ReadlineInput {
  value: string
  selectionStart: number
  selectionEnd: number
  key: string
  ctrlKey: boolean
  altKey: boolean
  yankText: string
  multiline: boolean
}

function replaceRange(
  value: string,
  start: number,
  end: number,
  replacement: string,
): ReadlineEdit {
  const next = value.slice(0, start) + replacement + value.slice(end)
  const caret = start + replacement.length
  return { value: next, selectionStart: caret, selectionEnd: caret }
}

function lineStart(value: string, position: number): number {
  return value.lastIndexOf('\n', Math.max(0, position - 1)) + 1
}

function lineEnd(value: string, position: number): number {
  const end = value.indexOf('\n', position)
  return end === -1 ? value.length : end
}

function previousWordStart(value: string, position: number): number {
  let cursor = position
  while (cursor > 0 && /\s/.test(value[cursor - 1]!)) cursor -= 1
  while (cursor > 0 && !/\s/.test(value[cursor - 1]!)) cursor -= 1
  return cursor
}

function nextWordEnd(value: string, position: number): number {
  let cursor = position
  while (cursor < value.length && /\s/.test(value[cursor]!)) cursor += 1
  while (cursor < value.length && !/\s/.test(value[cursor]!)) cursor += 1
  return cursor
}

function verticalPosition(
  value: string,
  position: number,
  direction: -1 | 1,
): number {
  const start = lineStart(value, position)
  const column = position - start
  if (direction === -1) {
    if (start === 0) return position
    const targetEnd = start - 1
    const targetStart = lineStart(value, targetEnd)
    return Math.min(targetStart + column, targetEnd)
  }
  const end = lineEnd(value, position)
  if (end === value.length) return position
  const targetStart = end + 1
  const targetEnd = lineEnd(value, targetStart)
  return Math.min(targetStart + column, targetEnd)
}

export function applyReadlineEdit(input: ReadlineInput): ReadlineEdit | null {
  const {
    value,
    selectionStart,
    selectionEnd,
    key,
    ctrlKey,
    altKey,
    yankText,
    multiline,
  } = input
  const lower = key.toLowerCase()
  if (altKey && lower === 'b') {
    const caret = previousWordStart(value, selectionStart)
    return { value, selectionStart: caret, selectionEnd: caret }
  }
  if (altKey && lower === 'f') {
    const caret = nextWordEnd(value, selectionEnd)
    return { value, selectionStart: caret, selectionEnd: caret }
  }
  if (!ctrlKey) return null
  if (lower === 'a') {
    const caret = lineStart(value, selectionStart)
    return { value, selectionStart: caret, selectionEnd: caret }
  }
  if (lower === 'e') {
    const caret = lineEnd(value, selectionEnd)
    return { value, selectionStart: caret, selectionEnd: caret }
  }
  if (lower === 'b') {
    const caret = Math.max(0, selectionStart - 1)
    return { value, selectionStart: caret, selectionEnd: caret }
  }
  if (lower === 'f') {
    const caret = Math.min(value.length, selectionEnd + 1)
    return { value, selectionStart: caret, selectionEnd: caret }
  }
  if (lower === 'p' && multiline) {
    const caret = verticalPosition(value, selectionStart, -1)
    return { value, selectionStart: caret, selectionEnd: caret }
  }
  if (lower === 'n' && multiline) {
    const caret = verticalPosition(value, selectionEnd, 1)
    return { value, selectionStart: caret, selectionEnd: caret }
  }
  if (lower === 'y') {
    return replaceRange(value, selectionStart, selectionEnd, yankText)
  }
  if (lower === 'k') {
    const end = selectionStart === selectionEnd
      ? Math.min(value.length, lineEnd(value, selectionEnd) + 1)
      : selectionEnd
    return {
      ...replaceRange(value, selectionStart, end, ''),
      killedText: value.slice(selectionStart, end),
    }
  }
  if (lower === 'u') {
    const start = selectionStart === selectionEnd
      ? lineStart(value, selectionStart)
      : selectionStart
    return {
      ...replaceRange(value, start, selectionEnd, ''),
      killedText: value.slice(start, selectionEnd),
    }
  }
  if (lower === 'w') {
    const start = selectionStart === selectionEnd
      ? previousWordStart(value, selectionStart)
      : selectionStart
    return {
      ...replaceRange(value, start, selectionEnd, ''),
      killedText: value.slice(start, selectionEnd),
    }
  }
  return null
}

import {
  createElement,
  type ComponentProps,
} from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BookProjectMenu } from '../../src/components/videobook/BookProjectMenu'
import {
  formatArtifactCount,
  formatNotebookCount,
  type BookProjectSummary,
} from '../../src/videobook/book-project-catalog'
import {
  transitionBookProjectMenuMode,
  type BookProjectMenuMode,
  type BookProjectMenuModeAction,
} from '../../src/videobook/book-project-menu-state'

const books: BookProjectSummary[] = [
  {
    bookId: '018f1000-0000-7000-8000-000000000001',
    name: 'active-story',
    createdAt: 2,
    artifactCount: 5,
    notebookCount: 2,
  },
  {
    bookId: '018f1000-0000-7000-8000-000000000002',
    name: 'empty-story',
    createdAt: 1,
    artifactCount: 0,
    notebookCount: 1,
  },
]

const successfulResult = Promise.resolve({ ok: true } as const)

const baseProps: ComponentProps<typeof BookProjectMenu> = {
  activeBook: books[0] ?? null,
  books,
  disabled: false,
  error: null,
  loading: false,
  open: true,
  onCreate: () => successfulResult,
  onDelete: () => successfulResult,
  onOpenChange: () => undefined,
  onRefresh: () => undefined,
  onRename: () => successfulResult,
  onSelect: () => successfulResult,
}

function renderMenu(
  overrides: Partial<ComponentProps<typeof BookProjectMenu>> = {},
): string {
  return renderToStaticMarkup(createElement(BookProjectMenu, {
    ...baseProps,
    ...overrides,
  }))
}

describe('BookProjectMenu', () => {
  it('renders the active project and keeps the catalog closed by default', () => {
    const html = renderMenu({ open: false })

    expect(html).toContain('active-story')
    expect(html).toContain('title="5 artifacts"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('id="book-project-menu"')
  })

  it('shows project counts, active state, and lifecycle actions', () => {
    const html = renderMenu()

    expect(html).toContain('id="book-project-menu"')
    expect(html).toContain('2 total')
    expect(html).toContain('aria-current="true"')
    expect(html).toContain('2 notebooks')
    expect(html).toContain('1 notebook')
    expect(html).toContain('title="5 artifacts"')
    expect(html).toContain('title="0 artifacts"')
    expect(html).toContain('aria-label="Rename active-story"')
    expect(html).toContain('aria-label="Delete active-story"')
    expect(html).toContain('New project')
  })

  it('protects the last project from deletion', () => {
    const onlyBook = books[0]!
    const html = renderMenu({
      activeBook: onlyBook,
      books: [onlyBook],
    })

    expect(html).toContain('Create another project before deleting this one')
    expect(html).toMatch(/disabled=""[^>]+aria-label="Delete active-story"/)
  })

  it('surfaces refresh progress, errors, and an empty catalog', () => {
    const html = renderMenu({
      activeBook: null,
      books: [],
      error: 'Catalog unavailable',
      loading: true,
    })

    expect(html).toContain('Catalog unavailable')
    expect(html).toContain('Retry')
    expect(html).toContain('Loading projects')
    expect(html).toContain('class="busy-indicator"')
    expect(html).toContain('lucide-activity')
    expect(html).not.toContain('lucide-loader-circle')
    expect(html).toContain('select-project')
  })

  it('formats singular and plural catalog counts', () => {
    expect(formatArtifactCount(1)).toBe('1 artifact')
    expect(formatArtifactCount(2)).toBe('2 artifacts')
    expect(formatNotebookCount(1)).toBe('1 notebook')
    expect(formatNotebookCount(2)).toBe('2 notebooks')
  })
})

const activeModes: BookProjectMenuMode[] = [
  { kind: 'create' },
  { kind: 'rename', bookId: 'book-a' },
  { kind: 'delete', bookId: 'book-b' },
]

describe('book project menu mode transitions', () => {
  it.each(activeModes)('unwinds $kind mode before closing on Escape', (mode) => {
    expect(transitionBookProjectMenuMode(
      mode,
      { kind: 'escape' },
      false,
    )).toEqual({ mode: { kind: 'idle' }, closeMenu: false })
  })

  it('closes from idle mode on Escape', () => {
    const mode = { kind: 'idle' } as const

    expect(transitionBookProjectMenuMode(
      mode,
      { kind: 'escape' },
      false,
    )).toEqual({ mode, closeMenu: true })
  })

  it.each([
    { kind: 'begin-create' },
    { kind: 'begin-rename', bookId: 'book-a' },
    { kind: 'begin-delete', bookId: 'book-b' },
    { kind: 'cancel' },
    { kind: 'close' },
    { kind: 'escape' },
  ] satisfies BookProjectMenuModeAction[])('locks $kind while an action is pending', (action) => {
    const mode = { kind: 'rename', bookId: 'book-a' } as const

    expect(transitionBookProjectMenuMode(mode, action, true)).toEqual({
      mode,
      closeMenu: false,
    })
  })

  it.each([
    [{ kind: 'begin-create' }, { kind: 'create' }],
    [
      { kind: 'begin-rename', bookId: 'book-a' },
      { kind: 'rename', bookId: 'book-a' },
    ],
    [
      { kind: 'begin-delete', bookId: 'book-b' },
      { kind: 'delete', bookId: 'book-b' },
    ],
  ] satisfies Array<[BookProjectMenuModeAction, BookProjectMenuMode]>) (
    'makes $0.kind the exclusive active mode',
    (action, expectedMode) => {
      for (const mode of activeModes) {
        expect(transitionBookProjectMenuMode(mode, action, false)).toEqual({
          mode: expectedMode,
          closeMenu: false,
        })
      }
    },
  )
})

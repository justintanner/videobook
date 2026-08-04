import {
  createElement,
  type ComponentProps,
} from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BookProjectSelector } from '../../src/components/videobook/BookProjectSelector'
import {
  formatArtifactCount,
  formatNotebookCount,
  type BookProjectSummary,
} from '../../src/videobook/book-project-selector'

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

const baseProps: ComponentProps<typeof BookProjectSelector> = {
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

function renderSelector(
  overrides: Partial<ComponentProps<typeof BookProjectSelector>> = {},
): string {
  return renderToStaticMarkup(createElement(BookProjectSelector, {
    ...baseProps,
    ...overrides,
  }))
}

describe('BookProjectSelector', () => {
  it('renders the active project and keeps the catalog closed by default', () => {
    const html = renderSelector({ open: false })

    expect(html).toContain('active-story')
    expect(html).toContain('title="5 artifacts"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('id="book-project-menu"')
  })

  it('shows project counts, active state, and lifecycle actions', () => {
    const html = renderSelector()

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
    const html = renderSelector({
      activeBook: onlyBook,
      books: [onlyBook],
    })

    expect(html).toContain('Create another project before deleting this one')
    expect(html).toMatch(/disabled=""[^>]+aria-label="Delete active-story"/)
  })

  it('surfaces refresh progress, errors, and an empty catalog', () => {
    const html = renderSelector({
      activeBook: null,
      books: [],
      error: 'Catalog unavailable',
      loading: true,
    })

    expect(html).toContain('Catalog unavailable')
    expect(html).toContain('Retry')
    expect(html).toContain('Loading projects')
    expect(html).toContain('select-project')
  })

  it('formats singular and plural catalog counts', () => {
    expect(formatArtifactCount(1)).toBe('1 artifact')
    expect(formatArtifactCount(2)).toBe('2 artifacts')
    expect(formatNotebookCount(1)).toBe('1 notebook')
    expect(formatNotebookCount(2)).toBe('2 notebooks')
  })
})

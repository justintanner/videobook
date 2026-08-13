import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  NotebookCellContextMenu,
  type NotebookCellContextAction,
} from '../../src/components/videobook/NotebookCellContextMenu'

const actions: NotebookCellContextAction[] = [
  {
    id: 'inspect',
    label: 'Edit cell',
    icon: 'inspect',
  },
  {
    id: 'run',
    label: 'Generate',
    icon: 'run',
    disabled: true,
  },
  {
    id: 'media',
    label: 'Open media',
    icon: 'media',
  },
  {
    id: 'duplicate',
    label: 'Duplicate',
    icon: 'duplicate',
  },
  {
    id: 'generations',
    label: 'View generations',
    icon: 'generations',
  },
  {
    id: 'source',
    label: 'View source',
    icon: 'source',
  },
]

describe('NotebookCellContextMenu', () => {
  it('renders important cell actions with delete isolated at the bottom', () => {
    const html = renderToStaticMarkup(createElement(NotebookCellContextMenu, {
      actions,
      address: '@b4',
      cellType: 'GEN VIDEO',
      menuId: 'cell-context-menu-cell-1',
      position: { x: 120, y: 80 },
      returnFocus: null,
      onAction: () => undefined,
      onClose: () => undefined,
      onDelete: () => undefined,
    }))

    expect(html).toContain('role="menu"')
    expect(html).toContain('aria-label="Cell actions for @b4"')
    expect(html).toContain('data-cell-action="inspect"')
    expect(html).toContain('data-cell-action="run" disabled=""')
    expect(html).toContain('data-cell-action="media"')
    expect(html).toContain('data-cell-action="duplicate"')
    expect(html).toContain('data-cell-action="generations"')
    expect(html).toContain('data-cell-action="source"')
    expect(html).toContain('class="cell-context-menu-danger"')
    expect(html).toContain('aria-keyshortcuts="Delete Backspace"')
    expect(html.indexOf('View source')).toBeLessThan(html.indexOf('Delete cell'))
    expect(html.indexOf('data-cell-action="delete"')).toBeGreaterThan(
      html.indexOf('data-cell-action="source"'),
    )
  })
})

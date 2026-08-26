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
    id: 'generate_video',
    label: 'Generate video',
    icon: 'generate-video',
  },
  {
    id: 'generate_image',
    label: 'Generate image',
    icon: 'generate-image',
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
    expect(html).toContain('data-cell-action="generate_video"')
    expect(html).toContain('data-cell-action="generate_image"')
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

  it('renders an empty grid slot menu without the delete section', () => {
    const html = renderToStaticMarkup(createElement(NotebookCellContextMenu, {
      actions: [{
        id: 'group_images',
        label: 'Group images here',
        icon: 'group-images',
      }],
      address: '@c5',
      cellType: 'EMPTY',
      menuId: 'slot-context-menu-2-4',
      menuLabel: 'Slot actions for @c5',
      position: { x: 40, y: 60 },
      returnFocus: null,
      onAction: () => undefined,
      onClose: () => undefined,
    }))

    expect(html).toContain('aria-label="Slot actions for @c5"')
    expect(html).toContain('data-cell-action="group_images"')
    expect(html).toContain('Group images here')
    expect(html).not.toContain('cell-context-menu-danger')
    expect(html).not.toContain('data-cell-action="delete"')
  })
})

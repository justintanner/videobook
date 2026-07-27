import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { NotebookCell } from 'videobook-engine'
import { NotebookCellInspector } from '../../src/components/videobook/NotebookCellInspector'
import { NotebookMediaFullscreen } from '../../src/components/videobook/NotebookMediaFullscreen'
import { doltCellRows } from '../../src/videobook/dolt-cell-source'

const cell: NotebookCell = {
  id: '01900000-0000-7000-8000-000000000001',
  type: 'video',
  slug: 'vid-source',
  slot: { row: 1, column: 2 },
  inputs: {
    operation: 'download_video',
    selectedRangeSeconds: [1490, 1550],
  },
  outputArtifactId: '01900000-0000-7000-8000-000000000002',
}

describe('NotebookCellInspector', () => {
  it('renders output media without requiring an open action', () => {
    const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
      notebookId: '01900000-0000-7000-8000-000000000003',
      cell,
      cells: [cell],
      edges: [],
      asset: {
        artifactId: cell.outputArtifactId!,
        id: 'vid-source',
        type: 'video',
        mediaUrl: '/files/vid-source/original.mp4',
        thumbnailUrl: '/files/vid-source/original.jpg',
        width: 1920,
        height: 1080,
        duration: 30,
        audioInfo: null,
      },
      status: 'completed',
      busy: false,
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
    }))

    expect(html).toContain('<video')
    expect(html).toContain('preload="metadata"')
    expect(html).toContain('controls=""')
    expect(html).toContain('/files/vid-source/original.mp4')
    expect(html).toContain('>VIDEO</span>')
    expect(html).toContain('>preview</button>')
    expect(html).toContain('>inputs</button>')
    expect(html).toContain('>source</button>')
    expect(html).not.toContain('completed')
  })

  it('renders fullscreen video with playback and close controls only', () => {
    const html = renderToStaticMarkup(createElement(NotebookMediaFullscreen, {
      asset: {
        artifactId: cell.outputArtifactId!,
        id: 'vid-source',
        type: 'video',
        mediaUrl: '/files/vid-source/original.mp4',
        thumbnailUrl: '/files/vid-source/original.jpg',
        width: 1920,
        height: 1080,
        duration: 30,
        audioInfo: null,
      },
      slug: cell.slug,
      onClose: () => undefined,
    }))

    expect(html).toContain('<video')
    expect(html).toContain('controls=""')
    expect(html).toContain('autoPlay=""')
    expect(html).toContain('aria-label="Close fullscreen preview"')
    expect(html).not.toContain('Media cell inspector')
    expect(html).not.toContain('Dolt source')
    expect(html).not.toContain('Delete')
  })

  it('projects every persisted cells-table column with raw null and JSON values', () => {
    const rows = doltCellRows(
      '01900000-0000-7000-8000-000000000003',
      cell,
    )

    expect(rows.map((row) => row.column)).toEqual([
      'notebook_id',
      'cell_id',
      'type',
      'slug',
      'grid_row',
      'grid_column',
      'output_entity_id',
      'prompt',
      'provider',
      'model',
      'operation',
      'tool',
      'inputs_json',
      'output_artifact_id',
    ])
    expect(rows.find((row) => row.column === 'prompt')?.value).toBeNull()
    expect(rows.find((row) => row.column === 'inputs_json')?.value).toBe(
      '{"operation":"download_video","selectedRangeSeconds":[1490,1550]}',
    )
  })
})

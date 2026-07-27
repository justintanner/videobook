import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { NotebookCell } from 'videobook-engine'
import { NotebookCellInspector } from '../../src/components/videobook/NotebookCellInspector'
import { doltCellRows } from '../../src/videobook/dolt-cell-source'

const cell: NotebookCell = {
  id: '01900000-0000-7000-8000-000000000001',
  type: 'video',
  title: '@vid-source · downloaded clip',
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
      onRun: async () => undefined,
      onDelete: async () => undefined,
    }))

    expect(html).toContain('<video')
    expect(html).toContain('preload="auto"')
    expect(html).toContain('controls=""')
    expect(html).toContain('/files/vid-source/original.mp4')
    expect(html).toContain('>VIDEO</span>')
    expect(html).not.toContain('completed')
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
      'title',
      'grid_row',
      'grid_column',
      'entity_id',
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

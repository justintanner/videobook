import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { NotebookCell } from 'videobook-engine'
import { NotebookCellInspector } from '../../src/components/videobook/NotebookCellInspector'
import { NotebookMediaFullscreen } from '../../src/components/videobook/NotebookMediaFullscreen'
import {
  persistAndRunNotebookCell,
  startNotebookCellRun,
} from '../../src/videobook/notebook-cell-actions'
import {
  doltCellDisplayValue,
  doltCellRows,
} from '../../src/videobook/dolt-cell-source'

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
      clearing: false,
      deleting: false,
      sourceVisible: false,
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onClearSlot: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
    }))

    expect(html).toContain('<video')
    expect(html).toContain('preload="metadata"')
    expect(html).toContain('controls=""')
    expect(html).toContain('/files/vid-source/original.mp4')
    expect(html).not.toContain('role="tab"')
    expect(html).toContain('class="inspector-slug-field"')
    expect(html).toContain('value="vid-source"')
    expect(html).toContain('readOnly=""')
    expect(html).toContain('title="Click to edit slug"')
    expect(html).toContain('aria-label="Edit slug"')
    expect(html).not.toContain('aria-label="Save slug"')
    expect(html).toContain('class="inspector-media-field-label">VIDEO</span>')
    expect(html).toContain('<h3>Inputs</h3>')
    expect(html.indexOf('class="inspector-slug-field"')).toBeLessThan(
      html.indexOf('class="inspector-media-field-label"'),
    )
    expect(html.indexOf('class="inspector-media-field-label"')).toBeLessThan(
      html.indexOf('aria-label="Cell output media"'),
    )
    expect(html.indexOf('aria-label="Cell output media"')).toBeLessThan(
      html.indexOf('<h3>Inputs</h3>'),
    )
    expect(html).not.toContain('Dolt source')
    expect(html).toContain('inspector-clear-slot-button')
    expect(html).toContain('Clear slot')
    expect(html).toContain('inspector-delete-button')
    expect(html).toContain('Delete cell')
    expect(html).not.toContain('completed')
    expect(html).toContain(
      'class="inspector-cell-actions inspector-media-actions" aria-label="Cell actions"',
    )
    expect(html).not.toContain('record-card-actions inspector-media-actions')
    expect(html.indexOf('<h3>Inputs</h3>')).toBeLessThan(
      html.indexOf('class="inspector-cell-actions inspector-media-actions"'),
    )
    expect(html).toMatch(
      /inspector-clear-slot-button[\s\S]*<\/button><button[^>]*inspector-delete-button/,
    )
  })

  it('marks audio output for a compact media preview', () => {
    const audioCell: NotebookCell = {
      ...cell,
      type: 'audio',
      slug: 'aud-source',
      inputs: {
        audioRole: 'continuous-source',
      },
    }
    const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
      notebookId: '01900000-0000-7000-8000-000000000003',
      cell: audioCell,
      cells: [audioCell],
      edges: [],
      asset: {
        artifactId: audioCell.outputArtifactId!,
        id: 'aud-source',
        type: 'audio',
        mediaUrl: '/files/aud-source/original.m4a',
        thumbnailUrl: null,
        width: null,
        height: null,
        duration: 60.01,
        audioInfo: {
          channelLayout: 'stereo',
          channels: 2,
          codec: 'aac',
          durationSeconds: 60.01,
          sampleRateHz: 48_000,
        },
      },
      status: 'completed',
      busy: false,
      clearing: false,
      deleting: false,
      sourceVisible: false,
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onClearSlot: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
    }))

    expect(html).toContain('class="inspector-cell-preview inspector-cell-preview-audio"')
    expect(html).toContain('<audio')
    expect(html).toContain('/files/aud-source/original.m4a')
    expect(html).toContain('class="inspector-audio-role">Audio output</span>')
    expect(html).toContain('<dt>Duration</dt><dd>1:00.01</dd>')
    expect(html).toContain('<dt>Format</dt><dd>AAC · 48 kHz · stereo</dd>')
    expect(html).not.toContain('aria-label="Audio version"')
  })

  it('labels and selects the current saved audio version', () => {
    const audioCell: NotebookCell = {
      ...cell,
      type: 'audio',
      slug: 'aud-source',
      inputs: {
        audioRole: 'continuous-source',
        outputVersionArtifactIds: ['audio-one', 'audio-two'],
      },
      outputArtifactId: 'audio-two',
    }
    const currentAsset = {
      artifactId: 'audio-two',
      id: 'aud-source-2',
      type: 'audio',
      mediaUrl: '/files/aud-source-2/original.m4a',
      thumbnailUrl: null,
      width: null,
      height: null,
      duration: 30,
      audioInfo: {
        channelLayout: 'stereo',
        channels: 2,
        codec: 'aac',
        durationSeconds: 30,
        sampleRateHz: 48_000,
      },
    }
    const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
      notebookId: '01900000-0000-7000-8000-000000000003',
      cell: audioCell,
      cells: [audioCell],
      edges: [],
      asset: currentAsset,
      versionAssets: [
        {
          ...currentAsset,
          artifactId: 'audio-one',
          id: 'aud-source-1',
          mediaUrl: '/files/aud-source-1/original.m4a',
          duration: 15,
          audioInfo: {
            ...currentAsset.audioInfo,
            durationSeconds: 15,
          },
        },
        currentAsset,
      ],
      status: 'completed',
      busy: false,
      clearing: false,
      deleting: false,
      sourceVisible: false,
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onClearSlot: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
    }))

    expect(html).toContain('aria-label="Audio versions"')
    expect(html).toContain('aria-label="Audio version"')
    expect(html).toContain('Version 1 of 2')
    expect(html).toContain('Version 2 of 2 · current')
    expect(html).toContain('Current output')
    expect(html).toContain('value="audio-two" selected=""')
    expect(html).toContain('/files/aud-source-2/original.m4a')
    expect(html).toContain('<dt>Duration</dt><dd>0:30</dd>')
  })

  it('keeps inputs visible beneath a compact pending preview', () => {
    const pendingCell: NotebookCell = {
      ...cell,
      outputArtifactId: undefined,
    }
    const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
      notebookId: '01900000-0000-7000-8000-000000000003',
      cell: pendingCell,
      cells: [pendingCell],
      edges: [],
      asset: undefined,
      status: 'pending',
      busy: false,
      clearing: false,
      deleting: false,
      sourceVisible: false,
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onClearSlot: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
    }))

    expect(html).toContain('Output pending')
    expect(html.indexOf('class="inspector-slug-field"')).toBeLessThan(
      html.indexOf('Output pending'),
    )
    expect(html.indexOf('Output pending')).toBeLessThan(
      html.indexOf('<h3>Inputs</h3>'),
    )
    expect(html).toContain('inspector-clear-slot-button')
    expect(html).toContain('inspector-delete-button')
    expect(html).toContain('disabled=""')
  })

  it('shows passive cell deletion progress', () => {
    const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
      notebookId: '01900000-0000-7000-8000-000000000003',
      cell,
      cells: [cell],
      edges: [],
      asset: undefined,
      status: 'completed',
      busy: true,
      clearing: false,
      deleting: true,
      sourceVisible: false,
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onClearSlot: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
    }))

    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('Deleting…')
    expect(html).toContain('inspector-delete-button')
  })

  it('renders action cells with one save-and-run control', () => {
    const splitCell: NotebookCell = {
      ...cell,
      type: 'split_video',
      slug: 'split-video-02',
      operation: 'split_range',
      provider: 'local',
      tool: 'ffmpeg',
      inputs: {
        startSeconds: 15,
        endSeconds: 30,
      },
    }
    const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
      notebookId: '01900000-0000-7000-8000-000000000003',
      cell: splitCell,
      cells: [splitCell],
      edges: [],
      asset: undefined,
      status: 'completed',
      busy: false,
      clearing: false,
      deleting: false,
      sourceVisible: false,
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onClearSlot: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
    }))

    expect(html).toContain('inspector-executable-body')
    expect(html).toContain('class="inspector-cell-form"')
    expect(html).not.toContain('class="inspector-save-button"')
    expect(html).not.toContain('Save changes')
    expect(html).not.toContain('Unsaved changes')
    expect(html).not.toContain('aria-label="Action type"')
    expect(html).not.toContain('Cell type is fixed')
    expect(html).not.toContain('<select')
    expect(html).not.toContain('placeholder="Provider"')
    expect(html).not.toContain('placeholder="Model"')
    expect(html).not.toContain('placeholder="Operation"')
    expect(html).not.toContain('placeholder="Tool"')
    expect(html).toContain('Start seconds')
    expect(html).toContain('value="15"')
    expect(html).toContain('End seconds')
    expect(html).toContain('value="30"')
    expect(html).toContain('Split again')
    expect(html).toContain('Delete cell')
    expect(html.indexOf('Split again')).toBeLessThan(html.indexOf('Delete cell'))
    expect(html).not.toContain('completed')
  })

  it('persists dirty action fields before running', async () => {
    const calls: string[] = []
    const result = await persistAndRunNotebookCell({
      cellId: 'split-cell',
      dirty: true,
      valid: true,
      patch: {
        inputs: {
          startSeconds: 15,
          endSeconds: 30,
        },
      },
      onUpdate: async () => {
        calls.push('update')
        return true
      },
      onRun: async () => {
        calls.push('run')
      },
    })

    expect(result).toBe(true)
    expect(calls).toEqual(['update', 'run'])
  })

  it('marks a cell queued only after its run is accepted', async () => {
    const calls: string[] = []

    await startNotebookCellRun({
      start: async () => {
        calls.push('start')
        return { job_id: 'run-notebook-cell' }
      },
      onAccepted: () => {
        calls.push('queued')
      },
    })

    expect(calls).toEqual(['start', 'queued'])
  })

  it('does not mark a cell queued when its run is rejected', async () => {
    const calls: string[] = []

    await expect(startNotebookCellRun({
      start: async () => {
        calls.push('start')
        throw new Error('queue rejected')
      },
      onAccepted: () => {
        calls.push('queued')
      },
    })).rejects.toThrow('queue rejected')

    expect(calls).toEqual(['start'])
  })

  it('does not run an action when validation or persistence fails', async () => {
    const calls: string[] = []
    const invalid = await persistAndRunNotebookCell({
      cellId: 'split-cell',
      dirty: true,
      valid: false,
      patch: {},
      onUpdate: async () => {
        calls.push('invalid-update')
      },
      onRun: async () => {
        calls.push('invalid-run')
      },
    })
    const failedSave = await persistAndRunNotebookCell({
      cellId: 'split-cell',
      dirty: true,
      valid: true,
      patch: {},
      onUpdate: async () => {
        calls.push('failed-update')
        return false
      },
      onRun: async () => {
        calls.push('failed-run')
      },
    })

    expect(invalid).toBe(false)
    expect(failedSave).toBe(false)
    expect(calls).toEqual(['failed-update'])
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

  it('classifies only valid _json columns as nested JSON', () => {
    expect(doltCellDisplayValue({
      column: 'inputs_json',
      type: 'TEXT',
      value: '{"operation":"download_video","selectedRangeSeconds":[1490,1550]}',
    })).toEqual({
      kind: 'json',
      value: {
        operation: 'download_video',
        selectedRangeSeconds: [1490, 1550],
      },
    })
    expect(doltCellDisplayValue({
      column: 'inputs_json',
      type: 'TEXT',
      value: '{malformed',
    })).toEqual({
      kind: 'raw',
      value: '{malformed',
    })
    expect(doltCellDisplayValue({
      column: 'slug',
      type: 'TEXT',
      value: '{"raw":"scalar"}',
    })).toEqual({
      kind: 'raw',
      value: '{"raw":"scalar"}',
    })
    expect(doltCellDisplayValue({
      column: 'prompt',
      type: 'TEXT',
      value: null,
    })).toEqual({
      kind: 'null',
    })
  })

  it('shares the Dolt table renderer with non-passive cells', () => {
    const promptCell: NotebookCell = {
      ...cell,
      type: 'prompt',
      prompt: undefined,
      outputArtifactId: undefined,
    }
    const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
      notebookId: '01900000-0000-7000-8000-000000000003',
      cell: promptCell,
      cells: [promptCell],
      edges: [],
      asset: undefined,
      status: 'completed',
      busy: false,
      clearing: false,
      deleting: false,
      sourceVisible: true,
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onClearSlot: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
    }))

    expect(html).toContain('aria-label="Raw Dolt cells row"')
    expect(html).toContain('<th>Column</th><th>Type</th><th>Raw value</th>')
    expect(html).toContain('class="inspector-dolt-json-meta"')
    expect(html).toContain('<code class="dolt-json-kind">JSON</code>')
    expect(html).toContain('class="inspector-dolt-json-value"')
    expect(html).toContain('<td colSpan="3">')
    expect(html).toContain('aria-label="inputs_json JSON"')
    expect(html).toContain('class="json-key"')
    expect(html).toContain('<code class="dolt-null">NULL</code>')
    expect(html).not.toContain('inspector-delete-button')
    expect(html).not.toContain('class="inspector-slug-field"')
    expect(html).not.toContain('Clear slot')
  })

  it('keeps non-passive editing controls out of the source view', () => {
    const promptCell: NotebookCell = {
      ...cell,
      type: 'prompt',
      prompt: undefined,
      outputArtifactId: undefined,
    }
    const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
      notebookId: '01900000-0000-7000-8000-000000000003',
      cell: promptCell,
      cells: [promptCell],
      edges: [],
      asset: undefined,
      status: 'completed',
      busy: false,
      clearing: false,
      deleting: false,
      sourceVisible: false,
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onClearSlot: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
    }))

    expect(html).toContain('class="inspector-slug-field"')
    expect(html).toContain('inspector-delete-button')
    expect(html).toContain('Delete cell')
    expect(html).toContain('class="inspector-save-button" disabled=""')
    expect(html).toContain(
      'class="inspector-cell-actions" aria-label="Cell actions"',
    )
    expect(html).not.toContain('Dolt source')
  })
})

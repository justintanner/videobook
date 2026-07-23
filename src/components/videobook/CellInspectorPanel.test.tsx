import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { BookCellData } from '@/videobook/project-book'
import {
  CellInspectorPanel,
  type InspectorTab,
} from './CellInspectorPanel'

const cell: BookCellData = {
  actionId: 'action-1',
  kind: 'video',
  stage: 2,
  status: 'ready',
  slug: '@vid-dancing-cat',
  operation: 'generate dancing cat',
  revision: 'a'.repeat(40),
  actor: 'human',
  lane: 'human',
  prompt: 'A cat dances in a neon studio',
  model: 'google-omni',
  mediaUrl: '/files/studio/vid-dancing-cat/original.mp4',
  thumbnailUrl: '/files/studio/vid-dancing-cat/original.jpg',
  width: 1080,
  height: 1920,
  trail: [{
    id: 'event-1',
    title: 'Generate dancing cat',
    phase: 'completed',
    date: '2026-07-23T12:00:00.000Z',
    actor: 'google-flow',
    revision: 'b'.repeat(40),
  }],
  source: {
    id: 'action-1',
    projectId: 'project-1',
    operation: 'book:generate',
    title: 'Generate dancing cat',
    scope: 'artifact',
    actor: 'human',
    lane: 'human',
    date: '2026-07-23T12:00:00.000Z',
    phase: 'completed',
    parentActionIds: [],
    inputArtifacts: [],
    outputArtifacts: [],
    details: { prompt: 'A cat dances in a neon studio' },
    events: [],
  },
}

function renderInspector(tab: InspectorTab): string {
  return renderToStaticMarkup(
    <CellInspectorPanel
      cell={cell}
      tab={tab}
      onTabChange={() => undefined}
      onUpdate={() => undefined}
      onCommit={() => undefined}
    />,
  )
}

describe('CellInspectorPanel', () => {
  it('renders media and editable fields under Details', () => {
    const html = renderInspector('details')

    expect(html).toContain('role="tablist"')
    expect(html).toContain('Details')
    expect(html).toContain('History')
    expect(html).toContain('Source')
    expect(html).toContain('Selected video cell contents')
    expect(html).toContain('@vid-dancing-cat')
    expect(html).toContain('class="inspector-slug"')
    expect(html).toContain('title="Click to copy @vid-dancing-cat"')
    expect(html).toContain('tabindex="0"')
    expect(html).not.toContain('Copy slug')
    expect(html).not.toContain('<button type="button" aria-label="Copy')
    expect(html).not.toContain('>Label<')
    expect(html).toContain('Play media')
    expect(html).toContain('Download')
    expect(html).toContain('Auto route')
    expect(html).toContain('INPUT PORTS')
  })

  it('renders the action trail under History', () => {
    const html = renderInspector('history')

    expect(html).toContain('id="inspector-history-panel"')
    expect(html).toContain('completed')
    expect(html).toContain('Generate dancing cat')
    expect(html).toContain('google-flow')
  })

  it('renders rich action JSON under Source', () => {
    const html = renderInspector('source')

    expect(html).toContain('id="inspector-source-panel"')
    expect(html).toContain('Formatted action source')
    expect(html).toContain('class="json-key"')
    expect(html).toContain('book:generate')
  })
})

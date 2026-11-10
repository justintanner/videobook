import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { PlayerRef } from '@remotion/player'
import type { GraphicsEdit } from '../../../../server/src/graphics/edits'
import type { GraphicsLayerLayout } from '../../../../server/src/graphics/layout'
import type { GraphicsEditor } from '@/videobook/useGraphicsEditor'
import { graphicsBurnedNotice, graphicsLayoutWarnings, graphicsOverlayImages, type GraphicsStarterChoice } from '@/videobook/graphics-model'
import { GraphicsPreview } from './GraphicsPreview'
import { GraphicsQuickFields, GraphicsStarterRow, GraphicsWarnings } from './GraphicsQuickFields'
import './Graphics.css'

function Banner({ tone = 'info', children }: { tone?: 'info' | 'warning' | 'error'; children: ReactNode }) {
  return <div className="graphics-banner" data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>
}

function StatusBanners({ editor, onOpenSource }: { editor: GraphicsEditor; onOpenSource: (artifactId: string) => void }) {
  const { state } = editor
  const read = state.read
  if (state.loading && !read) return <Banner>Loading graphics…</Banner>
  const burned = read && state.target ? graphicsBurnedNotice(read.burned, state.target.artifactId) : null
  return (
    <>
      {burned && (
        <Banner tone="warning">
          <span className="graphics-banner-text">{burned.message}</span>
          {burned.sourceId && <button type="button" onClick={() => onOpenSource(burned.sourceId!)}>Edit the source</button>}
        </Banner>
      )}
      {state.save === 'conflict' && (
        <Banner tone="warning">
          <span className="graphics-banner-text">{state.saveError ?? 'These graphics changed elsewhere.'}</span>
          <button type="button" onClick={() => void editor.reload()}>Reload</button>
          <button type="button" onClick={() => void editor.keepMine()}>Keep my version</button>
        </Banner>
      )}
      {state.save === 'error' && (
        <Banner tone="error">
          <span className="graphics-banner-text">Not saved: {state.saveError}</span>
          <button type="button" onClick={() => void editor.flush()}>Retry</button>
        </Banner>
      )}
      {state.error && <Banner tone="error">{state.error}</Banner>}
    </>
  )
}

export function GraphicsBody({ editor, onOpenSource }: { editor: GraphicsEditor; onOpenSource: (artifactId: string) => void }) {
  const { state } = editor
  const playerRef = useRef<PlayerRef | null>(null)
  const [layout, setLayout] = useState<GraphicsLayerLayout[] | null>(null)
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null)
  const [guides, setGuides] = useState(true)
  const read = state.read
  const document = state.document
  const images = useMemo(() => graphicsOverlayImages(read), [read])
  const warnings = useMemo(() => (document ? graphicsLayoutWarnings(document, layout) : []), [document, layout])
  const source = useMemo(() => (read ? { width: read.source.width, height: read.source.height, durationSeconds: read.source.duration_seconds, fps: read.source.fps } : null), [read])
  const editable = document !== null && state.save !== 'conflict' && !state.rendering
  const onLayout = useCallback((next: GraphicsLayerLayout[]) => setLayout(next), [])
  const edit = useCallback((edits: GraphicsEdit[], coalesce: string | null = null) => editor.edit(edits, coalesce), [editor])
  const applyStarter = useCallback((starter: GraphicsStarterChoice) => {
    editor.edit([{ op: 'apply_template', template: starter.document }])
  }, [editor])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return
    if ((event.target as HTMLElement).closest('input, textarea, select')) return
    event.preventDefault()
    if (event.shiftKey) editor.redo()
    else editor.undo()
  }

  return (
    <div className="confirm-graphics" onKeyDown={onKeyDown}>
      <div className="graphics-status"><StatusBanners editor={editor} onOpenSource={onOpenSource} /></div>
      {document && state.target && source && (
        <GraphicsPreview
          document={document}
          mediaUrl={state.target.mediaUrl}
          source={source}
          images={images}
          layout={layout}
          playerRef={playerRef}
          guides={guides}
          selectedLayerId={selectedLayerId}
          onLayout={onLayout}
          onSelectLayer={setSelectedLayerId}
        />
      )}
      {document && read && (
        <div className="graphics-controls">
          <GraphicsQuickFields document={document} read={read} disabled={!editable} onEdit={edit} />
          <GraphicsStarterRow starters={read.starters} disabled={!editable} onApply={applyStarter} />
          <GraphicsWarnings warnings={warnings} />
          <label className="graphics-toggle">
            <input type="checkbox" checked={guides} onChange={(event) => setGuides(event.target.checked)} />
            Safe-area guides
          </label>
        </div>
      )}
    </div>
  )
}

import { graphicsCanvas, ORIGINAL_GRAPHICS_FRAME } from '../../../../server/src/graphics/frame'
import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { PlayerRef } from '@remotion/player'
import type { GraphicsEdit } from '../../../../server/src/graphics/edits'
import type { GraphicsLayerLayout } from '../../../../server/src/graphics/layout'
import type { GraphicsTextSlot } from '../../../../server/src/graphics/model'
import { graphicsAvoidBoxes } from '../../../../server/src/graphics/placement'
import type { GraphicsSuggestKind, GraphicsSuggestLanguage } from '../../../../server/src/graphics/slots'
import type { BookProjectSummary } from '@/videobook/book-project-catalog'
import type { GraphicsEditor } from '@/videobook/useGraphicsEditor'
import {
  graphicsBurnedNotice,
  graphicsCoverWarning,
  graphicsDrawnDocument,
  graphicsEffectiveFrame,
  graphicsSubtitle,
  graphicsImageChoices,
  graphicsLayerPlacements,
  graphicsLayoutWarnings,
  graphicsNextLayerId,
  graphicsOverlayImages,
  graphicsSelectionAfterRemove,
  graphicsSlotHolder,
  type GraphicsEditorAsset,
  type GraphicsEditorMention,
  type GraphicsTemplateChoice,
} from '@/videobook/graphics-model'
import { graphicsNudgePosition, graphicsShortcut, type GraphicsPoint } from '@/videobook/graphics-pointer'
import { GraphicsInspector, type GraphicsInspectorTab } from './GraphicsInspector'
import { GraphicsLayers } from './GraphicsLayers'
import { GraphicsPreview } from './GraphicsPreview'
import { GraphicsQuickFields, GraphicsWarnings } from './GraphicsQuickFields'
import { GraphicsSuggestionTray } from './GraphicsSuggestions'
import { GraphicsTemplates } from './GraphicsTemplates'
import { GraphicsFrameControl } from './GraphicsFrameControl'
import { GraphicsWatermark } from './GraphicsWatermark'
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

function isTextEntry(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
}

function isStage(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.classList.contains('graphics-stage')
}

export function GraphicsBody({ editor, assets, mentions, books, onOpenSource }: {
  editor: GraphicsEditor
  assets: readonly GraphicsEditorAsset[]
  mentions: readonly GraphicsEditorMention[]
  books: readonly BookProjectSummary[]
  onOpenSource: (artifactId: string) => void
}) {
  const { state } = editor
  const playerRef = useRef<PlayerRef | null>(null)
  const nudges = useRef(0)
  const [layout, setLayout] = useState<GraphicsLayerLayout[] | null>(null)
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null)
  const [activeSlot, setActiveSlot] = useState<GraphicsTextSlot | null>(null)
  const [inspectorTab, setInspectorTab] = useState<GraphicsInspectorTab | null>(null)
  const [guides, setGuides] = useState(true)
  const [snapping, setSnapping] = useState(true)
  const read = state.read
  const document = state.document
  const framing = graphicsEffectiveFrame(state.frame ?? ORIGINAL_GRAPHICS_FRAME, read, state.subtitleLanguage)
  const subtitle = graphicsSubtitle(read, state.subtitleLanguage)
  const watermark = state.target?.watermark ?? null
  const watermarkMode = watermark !== null
  const drawn = useMemo(() => (document ? graphicsDrawnDocument(document, watermarkMode) : null), [document, watermarkMode])
  const images = useMemo(() => graphicsOverlayImages(read), [read])
  const imageChoices = useMemo(() => graphicsImageChoices(assets, mentions), [assets, mentions])
  const selectedLayer = document?.layers.find((layer) => layer.id === selectedLayerId) ?? null
  const selectedBox = layout?.find((entry) => entry.layerId === selectedLayer?.id)?.box ?? null
  const warnings = useMemo(() => (document ? graphicsLayoutWarnings(document, layout, read ? graphicsCanvas(read.source, framing) : undefined) : []), [document, layout, read, framing])
  const placements = useMemo(() => (drawn && read ? graphicsLayerPlacements(drawn, layout, read, framing) : {}), [drawn, layout, read, framing])
  const coverWarnings = useMemo(() => Object.fromEntries(Object.entries(placements).flatMap(([layerId, placement]) => {
    const warning = graphicsCoverWarning(placement.covers)
    return warning ? [[layerId, warning]] : []
  })), [placements])
  const source = useMemo(() => (read ? { width: read.source.width, height: read.source.height, durationSeconds: read.source.duration_seconds, fps: read.source.fps } : null), [read])
  const canvas = useMemo(() => (source ? graphicsCanvas(source, framing) : null), [source, framing])
  const editable = document !== null && state.save !== 'conflict' && !state.rendering
  const onLayout = useCallback((next: GraphicsLayerLayout[]) => setLayout(next), [])
  const edit = useCallback((edits: GraphicsEdit[], coalesce: string | null = null) => editor.edit(edits, coalesce), [editor])
  const playhead = useCallback(() => (playerRef.current?.getCurrentFrame() ?? 0) / (source?.fps || 1), [source?.fps])
  const otherBooks = useMemo(() => books.filter((book) => book.bookId !== editor.bookId), [books, editor.bookId])
  const applyTemplate = useCallback((template: GraphicsTemplateChoice) => {
    editor.edit([{ op: 'apply_template', template: template.document }])
  }, [editor])
  const suggest = useCallback((kind: GraphicsSuggestKind, language: GraphicsSuggestLanguage) => {
    void editor.suggest(kind, language)
  }, [editor])
  const focusSlot = useCallback((slot: GraphicsTextSlot | null) => {
    setActiveSlot(slot)
    const holder = slot && document ? graphicsSlotHolder(document, slot) : null
    if (holder) setSelectedLayerId(holder.layerId)
  }, [document])
  const pickSuggestion = useCallback((slot: GraphicsTextSlot, option: string) => {
    editor.edit([{ op: 'set_slot_text', slot, text: option }])
  }, [editor])
  const selectedPlacement = selectedLayer ? placements[selectedLayer.id] ?? null : null
  const findClearSpot = useCallback(async () => {
    if (!selectedLayer || !selectedPlacement?.drawn || !drawn || !layout || !source) return { ok: false, message: 'This layer draws nothing yet.' }
    return editor.findClearSpot({
      layerId: selectedLayer.id,
      box: selectedPlacement.drawn,
      block: selectedPlacement.block,
      avoid: graphicsAvoidBoxes(drawn, layout, selectedLayer.id, source.durationSeconds),
      detect: selectedPlacement.unchecked > 0,
    })
  }, [drawn, editor, layout, selectedLayer, selectedPlacement, source])

  const nudge = (delta: GraphicsPoint, repeat: boolean) => {
    if (!source || !selectedLayer || selectedLayer.kind === 'scrim' || !selectedBox) return
    if (!repeat) nudges.current += 1
    const position = graphicsNudgePosition(canvas ?? source, selectedLayer.position, selectedBox, delta)
    edit([{ op: 'set_position', layer_id: selectedLayer.id, position }], `nudge:${selectedLayer.id}:${nudges.current}`)
  }

  const removeSelected = () => {
    if (!document || !selectedLayer) return
    const next = graphicsSelectionAfterRemove(document, selectedLayer.id)
    if (edit([{ op: 'remove_layer', layer_id: selectedLayer.id }])) setSelectedLayerId(next)
  }

  const duplicateSelected = () => {
    if (!document || !selectedLayer) return
    const copyId = graphicsNextLayerId(document)
    if (edit([{ op: 'duplicate_layer', layer_id: selectedLayer.id }])) setSelectedLayerId(copyId)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || !source || isTextEntry(event.target)) return
    const shortcut = graphicsShortcut(event, canvas ?? source)
    if (!shortcut) return
    if (shortcut.kind === 'undo' || shortcut.kind === 'redo') {
      event.preventDefault()
      if (shortcut.kind === 'undo') editor.undo()
      else editor.redo()
      return
    }
    if (!selectedLayer || !editable || (shortcut.kind === 'nudge' && isStage(event.target))) return
    event.preventDefault()
    if (shortcut.kind === 'nudge') nudge(shortcut.delta, event.repeat)
    else if (shortcut.kind === 'delete') removeSelected()
    else duplicateSelected()
  }

  return (
    <div className="confirm-graphics" onKeyDown={onKeyDown}>
      <div className="graphics-status"><StatusBanners editor={editor} onOpenSource={onOpenSource} /></div>
      {drawn && state.target && source && (
        <GraphicsPreview
          document={drawn}
          mediaUrl={state.target.mediaUrl}
          source={source}
          framing={framing}
          background={subtitle?.background}
          images={images}
          layout={layout}
          playerRef={playerRef}
          guides={guides}
          snapping={snapping}
          editable={editable}
          selectedLayerId={selectedLayerId}
          activeSlot={activeSlot}
          onLayout={onLayout}
          onSelectLayer={setSelectedLayerId}
          onEdit={edit}
        />
      )}
      {document && drawn && read && (
        <div className="graphics-controls">
          {watermark && <GraphicsWatermark editor={editor} read={read} platform={watermark.platform} disabled={!editable} />}
          <div className="graphics-toolbar">
            <GraphicsTemplates editor={editor} read={read} disabled={!editable} books={otherBooks} onApply={applyTemplate} />
            <div className="graphics-toggles" role="group" aria-label="Preview guides">
              <label className="graphics-toggle" title="Safe-area guides">
                <input type="checkbox" checked={guides} onChange={(event) => setGuides(event.target.checked)} />
                Guides
              </label>
              <label className="graphics-toggle" title="Snap to guides. Hold Alt (Option), Ctrl or Command while dragging to move freely once.">
                <input type="checkbox" checked={snapping} onChange={(event) => setSnapping(event.target.checked)} />
                Snap
              </label>
            </div>
          </div>
          {!watermark && <GraphicsFrameControl frame={framing} source={read.source} mediaUrl={state.target?.mediaUrl ?? ''} disabled={!editable || Boolean(subtitle)} subtitleAspect={subtitle?.aspect} onChange={editor.setFrame} />}
          <GraphicsWarnings warnings={warnings} />
          <div className="graphics-columns">
            <GraphicsQuickFields
              document={document}
              read={read}
              disabled={!editable}
              suggestions={state.suggestions}
              onEdit={edit}
              onSuggest={suggest}
              onFocusSlot={focusSlot}
            />
            <div className="graphics-side">
              <GraphicsSuggestionTray
                document={document}
                suggestions={state.suggestions}
                disabled={!editable}
                onPick={pickSuggestion}
                onDismiss={editor.dismissSuggestions}
              />
              {selectedLayer
                ? (
                  <GraphicsInspector
                    key={selectedLayer.id}
                    document={document}
                    layer={selectedLayer}
                    read={read}
                    frame={canvas ?? undefined}
                    imageChoices={imageChoices}
                    box={selectedBox}
                    placement={selectedPlacement}
                    playhead={playhead}
                    disabled={!editable}
                    tab={inspectorTab}
                    onTab={setInspectorTab}
                    onEdit={edit}
                    onFindClearSpot={findClearSpot}
                  />
                )
                : <p className="graphics-muted graphics-side-hint">Select a layer in the list or the preview to edit it.</p>}
            </div>
          </div>
          <GraphicsLayers
            document={document}
            drawn={drawn}
            read={read}
            imageChoices={imageChoices}
            selectedLayerId={selectedLayer?.id ?? null}
            warnings={coverWarnings}
            disabled={!editable}
            playerRef={playerRef}
            onEdit={edit}
            onSelect={setSelectedLayerId}
          />
        </div>
      )}
    </div>
  )
}

import { graphicsAspectChanged, ORIGINAL_GRAPHICS_FRAME } from '../../../../server/src/graphics/frame'
import { lazy } from 'react'
import { Redo2, Undo2 } from 'lucide-react'
import { ConfirmSheet } from '../confirm/ConfirmSheet'
import type { ConfirmSheetEffect } from '../confirm/ConfirmSheetHints'
import type { BookProjectSummary } from '@/videobook/book-project-catalog'
import type { GraphicsEditor, GraphicsSaveState } from '@/videobook/useGraphicsEditor'
import { graphicsEffectiveFrame, graphicsRenderBlocker, type GraphicsEditorAsset, type GraphicsEditorMention, type GraphicsRenderOutput } from '@/videobook/graphics-model'

const GraphicsBody = lazy(async () => ({ default: (await import('./GraphicsBody')).GraphicsBody }))

const SAVE_LABELS: Record<GraphicsSaveState, string> = {
  saved: 'Saved',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  error: 'Not saved',
  conflict: 'Changed elsewhere',
}

const OUTPUT_EFFECTS: Record<GraphicsRenderOutput, ConfirmSheetEffect> = {
  new: { label: 'New video cell · source kept', tone: 'default' },
  replace: { label: 'Replaces the video · earlier version kept', tone: 'warning' },
}

function OutputChoice({ editor }: { editor: GraphicsEditor }) {
  const { state } = editor
  const frame = graphicsEffectiveFrame(state.frame ?? ORIGINAL_GRAPHICS_FRAME, state.read, state.subtitleLanguage)
  const changedAspect = state.read ? graphicsAspectChanged(state.read.source, frame) : false
  const replaceable = state.target?.kind === 'video' && !changedAspect
  return (
    <div className="graphics-segmented" role="group" aria-label="Render output">
      <button type="button" aria-pressed={state.output === 'new'} disabled={state.rendering} onClick={() => editor.setOutput('new')}>New video</button>
      <button type="button" aria-pressed={state.output === 'replace'} disabled={state.rendering || !replaceable}
        title={replaceable ? undefined : 'A changed aspect or exported timeline must render into a new video cell.'} onClick={() => editor.setOutput('replace')}>Replace video</button>
    </div>
  )
}

function HeaderActions({ editor }: { editor: GraphicsEditor }) {
  const { state } = editor
  return (
    <div className="graphics-head-actions">
      <button type="button" className="graphics-icon-button" aria-label="Undo" title="Undo (⌘Z)" disabled={state.past.length === 0 || state.rendering} onClick={editor.undo}><Undo2 size={14} aria-hidden="true" /></button>
      <button type="button" className="graphics-icon-button" aria-label="Redo" title="Redo (⇧⌘Z)" disabled={state.future.length === 0 || state.rendering} onClick={editor.redo}><Redo2 size={14} aria-hidden="true" /></button>
      <span className="graphics-save-state" data-state={state.save}>{SAVE_LABELS[state.save]}</span>
      <OutputChoice editor={editor} />
    </div>
  )
}

export function GraphicsSheet({ editor, assets, mentions, books, applyFormId, onClose, onOpenSource }: {
  editor: GraphicsEditor
  assets: readonly GraphicsEditorAsset[]
  mentions: readonly GraphicsEditorMention[]
  books: readonly BookProjectSummary[]
  applyFormId: string
  onClose: () => void
  onOpenSource: (artifactId: string) => void
}) {
  const { state } = editor
  const watermark = Boolean(state.target?.watermark)
  const blocking = graphicsRenderBlocker(state.document, state.read?.source.duration_seconds ?? null, state.save === 'conflict', watermark, state.frame)
  return (
    <ConfirmSheet
      kind="graphics"
      ariaLabel={watermark ? 'Watermark editor' : 'Graphics editor'}
      tag={watermark ? 'WATERMARK' : 'GRAPHICS'}
      title={`${watermark ? 'Watermark' : 'Graphics'} · ${state.target?.label ?? 'video'}`}
      address={state.target?.address ? `@${state.target.address}` : null}
      applyLabel="Render"
      cancelLabel="Close"
      busy={state.rendering}
      busyLabel="Queuing render…"
      effect={OUTPUT_EFFECTS[state.output]}
      validation={{ blocking, notice: null }}
      applyFormId={applyFormId}
      onCancel={onClose}
      headerActions={<HeaderActions editor={editor} />}
      secondaryActions={state.read?.subtitles?.length ? <SubtitleChoice editor={editor} /> : null}
    >
      <GraphicsBody key={state.target?.artifactId ?? 'none'} editor={editor} assets={assets} mentions={mentions} books={books} onOpenSource={onOpenSource} />
    </ConfirmSheet>
  )
}

function SubtitleChoice({ editor }: { editor: GraphicsEditor }) {
  const { state } = editor
  const drafts = state.read?.subtitles ?? []
  if (!drafts.length) return null
  const preferred = (drafts.find((draft) => draft.language === 'original') ?? drafts[0]).language
  const language = state.subtitleLanguage === undefined ? preferred : state.subtitleLanguage
  return (
    <div>
      <label><input type="checkbox" role="switch" checked={language !== null} disabled={state.rendering} onChange={(event) => editor.setSubtitleLanguage(event.target.checked ? preferred : null)} /> With subtitles</label>
      {language && drafts.length > 1 && <select aria-label="Subtitle language" value={language} disabled={state.rendering} onChange={(event) => editor.setSubtitleLanguage(event.target.value)}>{drafts.map((draft) => <option key={draft.language} value={draft.language}>{draft.language === 'original' ? 'Original language' : draft.language}</option>)}</select>}
      {language && <span> Uses the subtitle draft’s frame and background.</span>}
    </div>
  )
}

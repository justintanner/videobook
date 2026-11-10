import { lazy } from 'react'
import { Redo2, Undo2 } from 'lucide-react'
import { ConfirmSheet } from '../confirm/ConfirmSheet'
import type { ConfirmSheetEffect } from '../confirm/ConfirmSheetHints'
import type { GraphicsEditor, GraphicsSaveState } from '@/videobook/useGraphicsEditor'
import { graphicsRenderBlocker, type GraphicsRenderOutput } from '@/videobook/graphics-model'

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
  const replaceable = state.target?.kind === 'video'
  return (
    <div className="graphics-segmented" role="group" aria-label="Render output">
      <button type="button" aria-pressed={state.output === 'new'} disabled={state.rendering} onClick={() => editor.setOutput('new')}>New video</button>
      <button type="button" aria-pressed={state.output === 'replace'} disabled={state.rendering || !replaceable}
        title={replaceable ? undefined : 'An exported timeline can only render a new copy.'} onClick={() => editor.setOutput('replace')}>Replace video</button>
    </div>
  )
}

export function GraphicsSheet({ editor, applyFormId, onClose, onOpenSource }: {
  editor: GraphicsEditor
  applyFormId: string
  onClose: () => void
  onOpenSource: (artifactId: string) => void
}) {
  const { state } = editor
  const blocking = graphicsRenderBlocker(state.document, state.read?.source.duration_seconds ?? null, state.save === 'conflict')
  return (
    <ConfirmSheet
      kind="graphics"
      ariaLabel="Graphics editor"
      tag="GRAPHICS"
      title={`Graphics · ${state.target?.label ?? 'video'}`}
      address={state.target?.address ? `@${state.target.address}` : null}
      applyLabel="Render"
      cancelLabel="Close"
      busy={state.rendering}
      busyLabel="Queuing render…"
      effect={OUTPUT_EFFECTS[state.output]}
      validation={{ blocking, notice: state.save === 'saved' ? null : SAVE_LABELS[state.save] }}
      applyFormId={applyFormId}
      onCancel={onClose}
      secondaryActions={(
        <div className="graphics-footer">
          <OutputChoice editor={editor} />
          <button type="button" aria-label="Undo" title="Undo (⌘Z)" disabled={state.past.length === 0 || state.rendering} onClick={editor.undo}><Undo2 size={14} aria-hidden="true" /></button>
          <button type="button" aria-label="Redo" title="Redo (⇧⌘Z)" disabled={state.future.length === 0 || state.rendering} onClick={editor.redo}><Redo2 size={14} aria-hidden="true" /></button>
          <span className="graphics-save-state" data-state={state.save}>{SAVE_LABELS[state.save]}</span>
        </div>
      )}
    >
      <GraphicsBody editor={editor} onOpenSource={onOpenSource} />
    </ConfirmSheet>
  )
}

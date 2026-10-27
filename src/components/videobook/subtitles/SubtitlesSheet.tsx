import { lazy } from 'react'
import { Redo2, Undo2 } from 'lucide-react'
import { captionsToSubtitleFile, type CaptionExportFormat } from '../../../../server/src/captions/export'
import type { CaptionDocument } from '../../../../server/src/captions/model'
import { ConfirmSheet } from '../confirm/ConfirmSheet'
import type { SubtitleEditor, SubtitleSaveState } from '@/videobook/useSubtitleEditor'
import { subtitlesRenderBlocker, type SubtitleRenderOutput } from '@/videobook/subtitles-model'
import type { ConfirmSheetEffect } from '../confirm/ConfirmSheetHints'

const SubtitlesBody = lazy(async () => ({ default: (await import('./SubtitlesBody')).SubtitlesBody }))

const SAVE_LABELS: Record<SubtitleSaveState, string> = {
  saved: 'Saved',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  error: 'Not saved',
  conflict: 'Changed elsewhere',
}

const OUTPUT_EFFECTS: Record<SubtitleRenderOutput, ConfirmSheetEffect> = {
  new: { label: 'New video cell · source kept', tone: 'default' },
  replace: { label: 'Replaces the video · earlier version kept', tone: 'warning' },
}

function OutputChoice({ editor }: { editor: SubtitleEditor }) {
  const { state } = editor
  const replaceable = state.target?.kind === 'video'
  return (
    <div className="subtitles-segmented subtitles-output" role="group" aria-label="Render output">
      <button type="button" aria-pressed={state.output === 'new'} disabled={state.rendering} onClick={() => editor.setOutput('new')}>New video</button>
      <button type="button" aria-pressed={state.output === 'replace'} disabled={state.rendering || !replaceable}
        title={replaceable ? undefined : 'An exported timeline can only render a new copy.'} onClick={() => editor.setOutput('replace')}>Replace video</button>
    </div>
  )
}

function download(document: CaptionDocument, label: string, format: CaptionExportFormat) {
  const blob = new Blob([captionsToSubtitleFile(document, format)], { type: format === 'srt' ? 'application/x-subrip' : 'text/vtt' })
  const url = URL.createObjectURL(blob)
  const anchor = window.document.createElement('a')
  anchor.href = url
  anchor.download = `${label.replace(/[^\p{L}\p{N}._ -]+/gu, '').trim() || 'subtitles'}.${format}`
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function SubtitlesSheet({ editor, applyFormId, onClose }: { editor: SubtitleEditor; applyFormId: string; onClose: () => void }) {
  const { state } = editor
  const label = state.target?.label ?? 'video'
  const blocking = subtitlesRenderBlocker(state.read, state.document, state.save === 'conflict')
  const document = state.document
  return (
    <ConfirmSheet
      kind="subtitles"
      ariaLabel="Subtitles editor"
      tag="SUBTITLES"
      title={`Subtitles · ${label}`}
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
        <div className="subtitles-footer">
          <OutputChoice editor={editor} />
          <button type="button" aria-label="Undo" title="Undo (⌘Z)" disabled={state.past.length === 0 || state.rendering} onClick={editor.undo}><Undo2 size={14} aria-hidden="true" /></button>
          <button type="button" aria-label="Redo" title="Redo (⇧⌘Z)" disabled={state.future.length === 0 || state.rendering} onClick={editor.redo}><Redo2 size={14} aria-hidden="true" /></button>
          <span className="subtitles-save-state" data-state={state.save}>{SAVE_LABELS[state.save]}</span>
          <button type="button" disabled={!document} onClick={() => document && download(document, label, 'srt')}>SRT</button>
          <button type="button" disabled={!document} onClick={() => document && download(document, label, 'vtt')}>VTT</button>
        </div>
      )}
    >
      <SubtitlesBody editor={editor} />
    </ConfirmSheet>
  )
}

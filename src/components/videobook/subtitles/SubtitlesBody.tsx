import { useCallback, useMemo, useRef, useState } from 'react'
import type { PlayerRef } from '@remotion/player'
import type { CaptionEdit } from '../../../../server/src/captions/edits'
import type { CaptionRegionFrame } from '../../../../server/src/captions/layout'
import type { SubtitleEditor } from '@/videobook/useSubtitleEditor'
import {
  activeSubtitleWordId,
  phraseOfWord,
  placeholderCaptionDocument,
  subtitlesPreparationLabel,
} from '@/videobook/subtitles-model'
import { SubtitlesControls } from './SubtitlesControls'
import { SubtitlesPreview, type SubtitlePositionTarget } from './SubtitlesPreview'
import { SubtitlesTranscript } from './SubtitlesTranscript'
import './Subtitles.css'

const NO_REGIONS: CaptionRegionFrame[] = []

function Banner({ tone = 'info', children }: { tone?: 'info' | 'warning' | 'error'; children: React.ReactNode }) {
  return <div className="subtitles-banner" data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>
}

function StatusBanners({ editor }: { editor: SubtitleEditor }) {
  const { state } = editor
  const read = state.read
  if (state.loading && !read) return <Banner>Loading subtitles…</Banner>
  if (!read) return state.error ? <Banner tone="error">{state.error}</Banner> : null
  const paid = read.paid_work
  return (
    <>
      {read.status === 'needs_prepare' && paid.length > 0 && (
        <Banner>
          <div className="subtitles-banner-text">
            <strong>Subtitles need a quick prep pass</strong>
            <ul>{paid.map((work) => <li key={work.component}>{work.description}</li>)}</ul>
            <span className="subtitles-banner-hint">Render prepares them first, then renders.</span>
          </div>
          <button type="button" className="subtitles-primary" disabled={state.preparing} onClick={() => void editor.prepare()}>Prepare</button>
        </Banner>
      )}
      {(read.status === 'preparing' || state.preparing) && (
        <Banner>
          <span className="subtitles-banner-text">
            {subtitlesPreparationLabel(read)}
            {state.renderQueued && <span className="subtitles-banner-hint"> Renders when ready.</span>}
          </span>
          <button type="button" onClick={() => void editor.cancelPreparation()}>Cancel</button>
        </Banner>
      )}
      {read.status === 'unavailable' && <Banner tone="warning">{read.message ?? 'Subtitles are unavailable for this video.'}</Banner>}
      {read.status === 'failed' && (
        <Banner tone="error">
          <span className="subtitles-banner-text">{read.message ?? 'Preparing the subtitles failed.'}</span>
          <button type="button" onClick={() => void editor.prepare()}>Retry</button>
        </Banner>
      )}
      {read.status === 'silent' && <Banner tone="warning">{read.message ?? 'This video has no audio to caption.'}</Banner>}
      {read.draft?.stale_source && (
        <Banner tone="warning">
          <span className="subtitles-banner-text">The video changed since these subtitles were edited.</span>
          <button type="button" onClick={() => void editor.resolve('realign')}>Realign</button>
          <button type="button" onClick={() => void editor.resolve('keep_timings')}>Keep timings</button>
          <button type="button" onClick={() => void editor.resolve('discard')}>Discard edits</button>
        </Banner>
      )}
      {!read.draft?.stale_source && read.draft?.analysis_newer && (
        <Banner>
          <span className="subtitles-banner-text">Newer analysis is available. Your corrections are kept when you update.</span>
          <button type="button" onClick={() => void editor.resolve('reseed')}>Update from analysis</button>
        </Banner>
      )}
      {state.save === 'conflict' && (
        <Banner tone="warning">
          <span className="subtitles-banner-text">{state.saveError ?? 'These subtitles changed elsewhere.'}</span>
          <button type="button" onClick={() => void editor.reload()}>Reload</button>
          <button type="button" onClick={() => void editor.keepMine()}>Keep my version</button>
        </Banner>
      )}
      {state.save === 'error' && (
        <Banner tone="error">
          <span className="subtitles-banner-text">Not saved: {state.saveError}</span>
          <button type="button" onClick={() => void editor.flush()}>Retry</button>
        </Banner>
      )}
      {state.error && <Banner tone="error">{state.error}</Banner>}
    </>
  )
}

export function SubtitlesBody({ editor }: { editor: SubtitleEditor }) {
  const { state } = editor
  const playerRef = useRef<PlayerRef | null>(null)
  const [selectedWordId, setSelectedWordId] = useState<string | null>(null)
  const [selectedPhraseId, setSelectedPhraseId] = useState<string | null>(null)
  const [positionTarget, setPositionTarget] = useState<SubtitlePositionTarget>('all')
  const [guides, setGuides] = useState(true)
  const [activeWordId, setActiveWordId] = useState<string | null>(null)
  const read = state.read
  const placeholder = useMemo(() => (read ? placeholderCaptionDocument(read) : null), [read])
  const document = state.document ?? placeholder
  const editable = state.document !== null && read?.status === 'ready' && !read.draft?.stale_source && state.save !== 'conflict' && !state.rendering
  const regions = read?.regions ?? NO_REGIONS
  const fps = document?.source.fps ?? 30

  const onFrameChange = useCallback((frame: number) => {
    if (!state.document) return
    setActiveWordId(activeSubtitleWordId(state.document, frame / fps))
  }, [fps, state.document])

  const seek = useCallback((seconds: number) => {
    playerRef.current?.seekTo(Math.max(0, Math.round(seconds * fps)))
  }, [fps])

  const selectWord = useCallback((wordId: string, phraseId: string) => {
    setSelectedWordId(wordId)
    setSelectedPhraseId(phraseId)
  }, [])

  const selectPhrase = useCallback((phraseId: string) => {
    setSelectedPhraseId(phraseId)
    setSelectedWordId((current) => (current && state.document && phraseOfWord(state.document, current) === phraseId ? current : null))
  }, [state.document])

  const edit = useCallback((edits: CaptionEdit[], coalesce: string | null = null) => editor.edit(edits, coalesce), [editor])

  const dragPosition = useCallback((centerY: number, phraseId: string) => {
    if (!editable) return
    const target = positionTarget === 'phrase' ? phraseId : null
    editor.edit([target ? { op: 'set_phrase_position', phrase_id: target, y: centerY } : { op: 'set_position', y: centerY }], `drag:${target ?? 'all'}`)
  }, [editable, editor, positionTarget])

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return
    const target = event.target as HTMLElement
    if (target.closest('input, textarea, select')) return
    event.preventDefault()
    if (event.shiftKey) editor.redo()
    else editor.undo()
  }

  return (
    <div className="confirm-subtitles" onKeyDown={onKeyDown}>
      <div className="subtitles-status"><StatusBanners editor={editor} /></div>
      {document && state.target && read && (
        <SubtitlesPreview
          document={document}
          mediaUrl={state.target.mediaUrl}
          source={{ width: read.source.width, height: read.source.height, durationSeconds: read.source.duration_seconds }}
          regions={regions}
          playerRef={playerRef}
          guides={guides}
          selectedPhraseId={selectedPhraseId}
          onFrameChange={onFrameChange}
          onDragPosition={dragPosition}
          onSelectPhrase={selectPhrase}
        />
      )}
      {state.document && (
        <SubtitlesTranscript
          document={state.document}
          activeWordId={activeWordId}
          selectedWordId={selectedWordId}
          selectedPhraseId={selectedPhraseId}
          disabled={!editable}
          onSeek={seek}
          onSelectWord={selectWord}
          onSelectPhrase={selectPhrase}
          onEdit={edit}
        />
      )}
      {state.document && (
        <SubtitlesControls
          document={state.document}
          language={state.language}
          regionsStatus={read?.components.regions?.status ?? null}
          selectedPhraseId={selectedPhraseId}
          positionTarget={positionTarget}
          guides={guides}
          disabled={!editable}
          onEdit={edit}
          onLanguage={(language) => void editor.setLanguage(language)}
          onPositionTarget={setPositionTarget}
          onGuides={setGuides}
          onAnalyzeRegions={() => void editor.prepare(['regions'])}
        />
      )}
    </div>
  )
}

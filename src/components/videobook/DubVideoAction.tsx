import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Languages, X } from 'lucide-react'
import { DUB_VIDEO_MAX_LANGUAGES, DUB_VIDEO_RATES_USD_PER_SECOND } from '../../../server/src/dub-video-contract'
import { useDubVideo } from '@/videobook/useDubVideo'
import type { MediaFileToolCall } from '@/videobook/use-media-file-actions'
import './DubVideoAction.css'

type DubEditor = ReturnType<typeof useDubVideo>

function DubVideoPicker({ editor, busy }: { editor: DubEditor; busy: boolean }) {
  const { phase, draft, languages, update, close } = editor
  const [search, setSearch] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  const searchField = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => {
    const element = dialog.current
    element?.showModal()
    searchField.current?.focus()
    return () => element?.close()
  }, [])
  const matches = languages.filter(lang => lang.toLowerCase().includes(search.trim().toLowerCase()))
  const locked = busy || !editor.available || editor.running
  const queued = phase.step === 'failed' && phase.retry === 'refresh'
  function toggle(lang: string) {
    void update({ language: draft.language.includes(lang) ? draft.language.filter(item => item !== lang) : [...draft.language, lang] })
  }

  return createPortal(
    <dialog ref={dialog} className="dub-video-picker" aria-label="Dub video" data-composer-focus="preserve"
      onKeyDown={event => event.stopPropagation()} onCancel={event => { event.preventDefault(); close() }}>
      <header><h2>Dub video</h2><button type="button" aria-label="Close dub picker" disabled={editor.running} onClick={close}><X size={16} /></button></header>
      <fieldset disabled={locked || queued || !languages.length}>
        <legend>Target languages ({draft.language.length}/{DUB_VIDEO_MAX_LANGUAGES})</legend>
        <input ref={searchField} type="search" aria-label="Search languages" placeholder="Search languages" value={search} onChange={event => setSearch(event.target.value)} />
        <div className="dub-language-list">
          {phase.step === 'loading' && <span role="status">Loading languages…</span>}
          {languages.length > 0 && !matches.length && <span>No matching languages</span>}
          {matches.map(lang => <label key={lang}><input type="checkbox" checked={draft.language.includes(lang)}
            disabled={!draft.language.includes(lang) && draft.language.length >= DUB_VIDEO_MAX_LANGUAGES} onChange={() => toggle(lang)} />{lang}</label>)}
        </div>
        {draft.language.length > 0 && <div className="dub-language-selection">{draft.language.map(lang =>
          <button key={lang} type="button" aria-label={`Remove ${lang}`} onClick={() => toggle(lang)}>{lang}<X size={12} /></button>)}</div>}
      </fieldset>
      <fieldset disabled={locked || queued || !languages.length}>
        <legend>Quality</legend>
        <div className="dub-quality">{(['speed', 'precision'] as const).map(quality => <label key={quality}>
          <input type="radio" name="dub-quality" checked={quality === draft.quality} onChange={() => void update({ quality })} />
          {quality === 'speed' ? 'Speed' : 'Precision'} · ${DUB_VIDEO_RATES_USD_PER_SECOND[quality].toFixed(2)}/s
        </label>)}</div>
        <label><input type="checkbox" checked={draft.lip_sync} onChange={event => void update({ lip_sync: event.target.checked })} />Lip sync</label>
        <label>Speakers <select value={draft.speakers ?? ''} onChange={event => void update({ speakers: Number(event.target.value) || undefined })}>
          <option value="">Auto</option>{Array.from({ length: 10 }, (_, index) => index + 1).map(count => <option key={count}>{count}</option>)}
        </select></label>
      </fieldset>
      {phase.step === 'failed' && <div role="alert">{phase.error} <button type="button" disabled={locked} onClick={() => void editor.retry()}>
        {queued ? 'Refresh notebook' : 'Retry'}</button></div>}
      <footer>
        <div role="status">
          {phase.step === 'quoted' && <><strong>Estimated total ${phase.usd.toFixed(2)}</strong><small>HeyGen bills by output length. The final price can vary.</small></>}
          {phase.step === 'estimating' && 'Estimating total…'}
        </div>
        <button type="button" className="dub-confirm" disabled={locked || phase.step !== 'quoted'} onClick={() => void editor.confirm()}>
          {editor.running ? 'Queuing…' : 'Confirm dub'}
        </button>
      </footer>
    </dialog>, document.body)
}

export function DubVideoAction({ call, bookId, notebookId, cellId, busy, onRefresh }: {
  call?: MediaFileToolCall
  bookId: string
  notebookId: string
  cellId: string
  busy: boolean
  onRefresh: () => Promise<unknown>
}) {
  const editor = useDubVideo(call, bookId, notebookId, cellId, onRefresh)
  return <>
    <button type="button" className="inspector-media-file-action" disabled={busy || !editor.available || editor.running}
      aria-haspopup="dialog" aria-busy={editor.running} onClick={() => void editor.open()}>
      <Languages size={13} aria-hidden="true" />{editor.running ? 'Dubbing…' : 'Dub'}
    </button>
    {editor.phase.step !== 'closed' && <DubVideoPicker editor={editor} busy={busy} />}
    {editor.notice && <span className="dub-notice" role="status">{editor.notice}</span>}
  </>
}

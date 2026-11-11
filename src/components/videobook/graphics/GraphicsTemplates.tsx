import { useState, type KeyboardEvent } from 'react'
import { Star, TriangleAlert } from 'lucide-react'
import { MAX_GRAPHICS_NAME_LENGTH } from '../../../../server/src/graphics/model'
import type { BookProjectSummary } from '@/videobook/book-project-catalog'
import { graphicsTemplateChoices, type GraphicsRead, type GraphicsTemplateChoice } from '@/videobook/graphics-model'
import type { GraphicsEditor, GraphicsTemplateOutcome } from '@/videobook/useGraphicsEditor'

type Run = (action: () => Promise<GraphicsTemplateOutcome>) => Promise<boolean>
type RowMode = 'idle' | 'rename' | 'delete'

function missingLabel(count: number): string {
  return count === 1 ? '1 image missing' : `${count} images missing`
}

function chipTitle(choice: GraphicsTemplateChoice): string {
  const notes = [
    choice.isDefault ? 'The look videos in this book start from.' : null,
    choice.missingImages > 0 ? `${missingLabel(choice.missingImages)}: that layer draws nothing until you choose another image.` : null,
  ]
  return [`Apply ${choice.name}.`, ...notes.filter((note) => note !== null)].join(' ')
}

function onEnter(event: KeyboardEvent<HTMLInputElement>, submit: () => void, cancel?: () => void): void {
  if (event.key === 'Enter') {
    event.preventDefault()
    submit()
  } else if (event.key === 'Escape' && cancel) {
    event.preventDefault()
    event.stopPropagation()
    cancel()
  }
}

function SaveTemplate({ disabled, onSave }: { disabled: boolean; onSave: (name: string) => Promise<boolean> }) {
  const [name, setName] = useState('')
  const save = async () => {
    const trimmed = name.trim()
    if (trimmed && await onSave(trimmed)) setName('')
  }
  return (
    <div className="graphics-template-save">
      <input
        type="text"
        aria-label="Template name"
        placeholder="Name this look"
        value={name}
        maxLength={MAX_GRAPHICS_NAME_LENGTH}
        disabled={disabled}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => onEnter(event, () => void save())}
      />
      <button type="button" disabled={disabled || !name.trim()} onClick={() => void save()}>Save as template</button>
    </div>
  )
}

function RenameRow({ choice, disabled, onRename, onDone }: { choice: GraphicsTemplateChoice; disabled: boolean; onRename: (name: string) => Promise<boolean>; onDone: () => void }) {
  const [draft, setDraft] = useState(choice.name)
  const rename = async () => {
    const name = draft.trim()
    if (!name || name === choice.name) return onDone()
    if (await onRename(name)) onDone()
  }
  return (
    <li className="graphics-template-item" data-template={choice.id}>
      <input
        className="graphics-layer-rename"
        aria-label={`New name for ${choice.name}`}
        value={draft}
        maxLength={MAX_GRAPHICS_NAME_LENGTH}
        autoFocus
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => onEnter(event, () => void rename(), onDone)}
      />
      <span className="graphics-template-actions">
        <button type="button" disabled={disabled} onClick={() => void rename()}>Save name</button>
        <button type="button" onClick={onDone}>Cancel</button>
      </span>
    </li>
  )
}

function TemplateRow({ choice, disabled, run, editor }: { choice: GraphicsTemplateChoice; disabled: boolean; run: Run; editor: GraphicsEditor }) {
  const [mode, setMode] = useState<RowMode>('idle')
  const idle = () => setMode('idle')
  if (mode === 'rename') {
    return <RenameRow choice={choice} disabled={disabled} onRename={(name) => run(() => editor.renameTemplate(choice.id, name))} onDone={idle} />
  }
  if (mode === 'delete') {
    return (
      <li className="graphics-template-item" data-template={choice.id}>
        <span className="graphics-template-name">Delete {choice.name}? Videos keep the graphics they already have.</span>
        <span className="graphics-template-actions">
          <button type="button" aria-label={`Confirm deleting ${choice.name}`} disabled={disabled} onClick={() => void run(() => editor.deleteTemplate(choice.id))}>Delete</button>
          <button type="button" onClick={idle}>Keep</button>
        </span>
      </li>
    )
  }
  return (
    <li className="graphics-template-item" data-template={choice.id} data-default={choice.isDefault ? 'true' : undefined}>
      <span className="graphics-template-name">
        {choice.name}
        {!choice.saved && <span className="graphics-template-kind">starter</span>}
        {choice.missingImages > 0 && <span className="graphics-template-missing"><TriangleAlert size={11} aria-hidden="true" />{missingLabel(choice.missingImages)}</span>}
      </span>
      <span className="graphics-template-actions">
        {choice.isDefault
          ? <span className="graphics-template-badge">Default</span>
          : <button type="button" aria-label={`Make ${choice.name} the default`} disabled={disabled} onClick={() => void run(() => editor.setDefaultTemplate(choice))}>Make default</button>}
        {choice.saved && (
          <>
            <button type="button" aria-label={`Save this look over ${choice.name}`} disabled={disabled} onClick={() => void run(() => editor.saveTemplate(null, choice.id))}>Update</button>
            <button type="button" aria-label={`Rename ${choice.name}`} disabled={disabled} onClick={() => setMode('rename')}>Rename</button>
            <button type="button" aria-label={`Delete ${choice.name}`} disabled={disabled} onClick={() => setMode('delete')}>Delete</button>
          </>
        )}
      </span>
    </li>
  )
}

function CopyFromBook({ books, disabled, run, editor }: { books: readonly BookProjectSummary[]; disabled: boolean; run: Run; editor: GraphicsEditor }) {
  const [chosen, setChosen] = useState('')
  if (books.length === 0) return <p className="graphics-muted">No other book to copy templates from.</p>
  const bookId = books.some((book) => book.bookId === chosen) ? chosen : books[0].bookId
  return (
    <div className="graphics-template-copy">
      <span className="graphics-section-label">Copy from</span>
      <select aria-label="Book to copy templates from" value={bookId} disabled={disabled} onChange={(event) => setChosen(event.target.value)}>
        {books.map((book) => <option key={book.bookId} value={book.bookId}>{book.name}</option>)}
      </select>
      <button type="button" disabled={disabled} onClick={() => void run(() => editor.copyTemplates(bookId))}>Copy templates</button>
    </div>
  )
}

export function GraphicsTemplates({ editor, read, disabled, books, onApply }: {
  editor: GraphicsEditor
  read: GraphicsRead
  disabled: boolean
  books: readonly BookProjectSummary[]
  onApply: (choice: GraphicsTemplateChoice) => void
}) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<GraphicsTemplateOutcome | null>(null)
  const [managing, setManaging] = useState(false)
  const choices = graphicsTemplateChoices(read)
  const locked = disabled || busy
  const run: Run = async (action) => {
    setBusy(true)
    setNotice(null)
    try {
      const outcome = await action()
      setNotice(outcome)
      return outcome.ok
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="graphics-templates" aria-label="Templates">
      <div className="graphics-templates-bar">
        <span className="graphics-section-label">Templates</span>
        <div className="graphics-starter-row" role="group" aria-label="Apply a template">
          {choices.map((choice) => (
            <button
              key={choice.id}
              type="button"
              data-template={choice.id}
              data-saved={choice.saved ? 'true' : undefined}
              data-default={choice.isDefault ? 'true' : undefined}
              title={chipTitle(choice)}
              disabled={disabled}
              onClick={() => onApply(choice)}
            >
              {choice.isDefault && <Star size={11} aria-hidden="true" />}
              {choice.name}
              {choice.missingImages > 0 && <TriangleAlert size={11} aria-hidden="true" />}
            </button>
          ))}
        </div>
        <SaveTemplate disabled={locked} onSave={(name) => run(() => editor.saveTemplate(name))} />
        <button type="button" aria-expanded={managing} onClick={() => setManaging((current) => !current)}>{managing ? 'Done' : 'Manage templates'}</button>
        {notice && <p className="graphics-template-notice" role={notice.ok ? 'status' : 'alert'} data-tone={notice.ok ? 'info' : 'error'}>{notice.message}</p>}
      </div>
      {managing && (
        <>
          <ul className="graphics-template-list" aria-label="Manage templates">
            {choices.map((choice) => <TemplateRow key={choice.id} choice={choice} disabled={locked} run={run} editor={editor} />)}
          </ul>
          <CopyFromBook books={books} disabled={locked} run={run} editor={editor} />
        </>
      )}
    </section>
  )
}

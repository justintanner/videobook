import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import {
  Check,
  ChevronDown,
  LoaderCircle,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import {
  formatArtifactCount,
  formatNotebookCount,
  type BookProjectMutationResult,
  type BookProjectSummary,
} from '@/videobook/book-project-selector'

type PendingAction =
  | { kind: 'create' }
  | { kind: 'delete'; bookId: string }
  | { kind: 'rename'; bookId: string }
  | { kind: 'select'; bookId: string }

type BookProjectSelectorProps = {
  activeBook: BookProjectSummary | null
  books: BookProjectSummary[]
  disabled: boolean
  error: string | null
  loading: boolean
  open: boolean
  onCreate: (name: string) => Promise<BookProjectMutationResult>
  onDelete: (
    bookId: string,
    confirmName: string,
  ) => Promise<BookProjectMutationResult>
  onOpenChange: (open: boolean) => void
  onRefresh: () => void
  onRename: (
    bookId: string,
    name: string,
  ) => Promise<BookProjectMutationResult>
  onSelect: (bookId: string) => Promise<BookProjectMutationResult>
}

export function BookProjectSelector({
  activeBook,
  books,
  disabled,
  error,
  loading,
  open,
  onCreate,
  onDelete,
  onOpenChange,
  onRefresh,
  onRename,
  onSelect,
}: BookProjectSelectorProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [editingBookId, setEditingBookId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [creating, setCreating] = useState(false)
  const [createValue, setCreateValue] = useState('')
  const [deletingBookId, setDeletingBookId] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [operationError, setOperationError] = useState<string | null>(null)

  const resetModes = useCallback(() => {
    setEditingBookId(null)
    setEditValue('')
    setCreating(false)
    setCreateValue('')
    setDeletingBookId(null)
    setOperationError(null)
  }, [])

  const closeMenu = useCallback(() => {
    if (pending) return
    resetModes()
    onOpenChange(false)
  }, [onOpenChange, pending, resetModes])

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return
      closeMenu()
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || pending) return
      if (editingBookId) {
        setEditingBookId(null)
        setEditValue('')
        setOperationError(null)
        return
      }
      if (creating) {
        setCreating(false)
        setCreateValue('')
        setOperationError(null)
        return
      }
      if (deletingBookId) {
        setDeletingBookId(null)
        setOperationError(null)
        return
      }
      closeMenu()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [
    closeMenu,
    creating,
    deletingBookId,
    editingBookId,
    open,
    pending,
  ])

  const beginCreate = () => {
    setEditingBookId(null)
    setEditValue('')
    setDeletingBookId(null)
    setOperationError(null)
    setCreating(true)
  }

  const beginRename = (book: BookProjectSummary) => {
    setCreating(false)
    setCreateValue('')
    setDeletingBookId(null)
    setOperationError(null)
    setEditingBookId(book.bookId)
    setEditValue(book.name)
  }

  const beginDelete = (bookId: string) => {
    if (books.length < 2) return
    setEditingBookId(null)
    setEditValue('')
    setCreating(false)
    setCreateValue('')
    setOperationError(null)
    setDeletingBookId(bookId)
  }

  const cancelMode = () => {
    if (pending) return
    resetModes()
  }

  const selectBook = async (bookId: string) => {
    if (disabled || pending || bookId === activeBook?.bookId) {
      if (bookId === activeBook?.bookId) closeMenu()
      return
    }
    setOperationError(null)
    setPending({ kind: 'select', bookId })
    const result = await onSelect(bookId)
    setPending(null)
    if (!result.ok) {
      setOperationError(result.error)
      return
    }
    closeMenu()
  }

  const submitRename = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!editingBookId || pending) return
    const name = editValue.trim()
    const current = books.find((book) => book.bookId === editingBookId)
    if (!name) {
      setOperationError('Enter a project name')
      return
    }
    if (name === current?.name) {
      cancelMode()
      return
    }
    setOperationError(null)
    setPending({ kind: 'rename', bookId: editingBookId })
    const result = await onRename(editingBookId, name)
    setPending(null)
    if (!result.ok) {
      setOperationError(result.error)
      return
    }
    cancelMode()
  }

  const submitCreate = async (event?: FormEvent) => {
    event?.preventDefault()
    if (pending) return
    const name = createValue.trim()
    if (!name) {
      setOperationError('Enter a project name')
      return
    }
    setOperationError(null)
    setPending({ kind: 'create' })
    const result = await onCreate(name)
    setPending(null)
    if (!result.ok) {
      setOperationError(result.error)
      return
    }
    resetModes()
    onOpenChange(false)
  }

  const confirmDelete = async (book: BookProjectSummary) => {
    if (pending || books.length < 2) return
    setOperationError(null)
    setPending({ kind: 'delete', bookId: book.bookId })
    const result = await onDelete(book.bookId, book.name)
    setPending(null)
    if (!result.ok) {
      setOperationError(result.error)
      return
    }
    resetModes()
  }

  const toggleMenu = () => {
    if (open) {
      closeMenu()
      return
    }
    onOpenChange(true)
  }

  const activeArtifactLabel = activeBook
    ? formatArtifactCount(activeBook.artifactCount)
    : 'No active project'
  const mutationDisabled = disabled || pending !== null

  return (
    <div className="book-project-selector" ref={rootRef}>
      <button
        type="button"
        className="brand-project-menu-toggle"
        aria-controls="book-project-menu"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={toggleMenu}
      >
        <strong>{activeBook?.name ?? 'select-project'}</strong>
        {activeBook && (
          <span
            className="book-project-active-count"
            title={activeArtifactLabel}
          >
            {activeBook.artifactCount}
          </span>
        )}
        <ChevronDown size={14} />
      </button>
      {open && (
        <div
          id="book-project-menu"
          className="book-project-menu"
          role="menu"
          aria-label="Videobook projects"
        >
          <header className="book-project-menu-header">
            <div>
              <span>Projects</span>
              {loading && <LoaderCircle className="spin" size={13} />}
            </div>
            <small>{books.length} total</small>
          </header>
          {error && (
            <div className="book-project-menu-message error" role="alert">
              <span>{error}</span>
              <button type="button" disabled={loading} onClick={onRefresh}>
                Retry
              </button>
            </div>
          )}
          {operationError && !editingBookId && !creating && !deletingBookId && (
            <div className="book-project-menu-message error" role="alert">
              <span>{operationError}</span>
            </div>
          )}
          <div className="book-project-menu-list">
            {loading && books.length === 0 && (
              <div className="book-project-menu-empty">
                <LoaderCircle className="spin" size={15} />
                <span>Loading projects</span>
              </div>
            )}
            {!loading && books.length === 0 && (
              <div className="book-project-menu-empty">
                No projects available
              </div>
            )}
            {books.map((book) => {
              const active = book.bookId === activeBook?.bookId
              const editing = book.bookId === editingBookId
              const deleting = book.bookId === deletingBookId
              const rowPending = pending && 'bookId' in pending
                ? pending.bookId === book.bookId
                : false
              const canDelete = books.length > 1

              if (editing) {
                return (
                  <form
                    key={book.bookId}
                    className="book-project-form"
                    onSubmit={submitRename}
                  >
                    <input
                      autoFocus
                      aria-label={`New name for ${book.name}`}
                      disabled={pending !== null}
                      value={editValue}
                      onChange={(event) => setEditValue(event.target.value)}
                    />
                    <div className="book-project-form-actions">
                      <button
                        type="submit"
                        disabled={pending !== null}
                        title="Save project name"
                        aria-label="Save project name"
                      >
                        {pending?.kind === 'rename'
                          ? <LoaderCircle className="spin" size={14} />
                          : <Check size={14} />}
                      </button>
                      <button
                        type="button"
                        disabled={pending !== null}
                        title="Cancel rename"
                        aria-label="Cancel rename"
                        onClick={cancelMode}
                      >
                        <X size={14} />
                      </button>
                    </div>
                    {operationError && (
                      <span className="book-project-form-error" role="alert">
                        {operationError}
                      </span>
                    )}
                  </form>
                )
              }

              if (deleting) {
                return (
                  <div
                    key={book.bookId}
                    className="book-project-delete"
                    role="group"
                    aria-label={`Delete ${book.name}`}
                  >
                    <Trash2 size={15} />
                    <div>
                      <strong>Delete {book.name}?</strong>
                      <small>
                        {formatArtifactCount(book.artifactCount)} and{' '}
                        {formatNotebookCount(book.notebookCount)} will be removed
                      </small>
                    </div>
                    <div className="book-project-form-actions">
                      <button
                        type="button"
                        disabled={pending !== null}
                        title={`Confirm deletion of ${book.name}`}
                        aria-label={`Confirm deletion of ${book.name}`}
                        onClick={() => void confirmDelete(book)}
                      >
                        {pending?.kind === 'delete'
                          ? <LoaderCircle className="spin" size={14} />
                          : <Check size={14} />}
                      </button>
                      <button
                        type="button"
                        disabled={pending !== null}
                        title="Cancel deletion"
                        aria-label="Cancel deletion"
                        onClick={cancelMode}
                      >
                        <X size={14} />
                      </button>
                    </div>
                    {operationError && (
                      <span className="book-project-form-error" role="alert">
                        {operationError}
                      </span>
                    )}
                  </div>
                )
              }

              return (
                <div
                  key={book.bookId}
                  className={`book-project-row ${active ? 'active' : ''}`}
                  aria-busy={rowPending}
                >
                  <button
                    type="button"
                    className="book-project-select"
                    role="menuitem"
                    aria-current={active ? 'true' : undefined}
                    disabled={mutationDisabled}
                    onClick={() => void selectBook(book.bookId)}
                  >
                    <span className="book-project-marker" />
                    <span className="book-project-copy">
                      <strong>{book.name}</strong>
                      <small>{formatNotebookCount(book.notebookCount)}</small>
                    </span>
                    <span
                      className={`book-project-artifact-count ${
                        book.artifactCount === 0 ? 'empty' : ''
                      }`}
                      title={formatArtifactCount(book.artifactCount)}
                    >
                      {rowPending
                        ? <LoaderCircle className="spin" size={12} />
                        : book.artifactCount}
                    </span>
                  </button>
                  <div className="book-project-actions">
                    <button
                      type="button"
                      disabled={mutationDisabled}
                      title={`Rename ${book.name}`}
                      aria-label={`Rename ${book.name}`}
                      onClick={() => beginRename(book)}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      disabled={mutationDisabled || !canDelete}
                      title={canDelete
                        ? `Delete ${book.name}`
                        : 'Create another project before deleting this one'}
                      aria-label={`Delete ${book.name}`}
                      onClick={() => beginDelete(book.bookId)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
          <footer className="book-project-menu-footer">
            {creating ? (
              <form className="book-project-form" onSubmit={submitCreate}>
                <input
                  autoFocus
                  aria-label="New project name"
                  disabled={pending !== null}
                  placeholder="project-name"
                  value={createValue}
                  onChange={(event) => setCreateValue(event.target.value)}
                />
                <div className="book-project-form-actions">
                  <button
                    type="submit"
                    disabled={pending !== null}
                    title="Create project"
                    aria-label="Create project"
                  >
                    {pending?.kind === 'create'
                      ? <LoaderCircle className="spin" size={14} />
                      : <Check size={14} />}
                  </button>
                  <button
                    type="button"
                    disabled={pending !== null}
                    title="Cancel new project"
                    aria-label="Cancel new project"
                    onClick={cancelMode}
                  >
                    <X size={14} />
                  </button>
                </div>
                {operationError && (
                  <span className="book-project-form-error" role="alert">
                    {operationError}
                  </span>
                )}
              </form>
            ) : (
              <button
                type="button"
                className="book-project-create"
                disabled={mutationDisabled}
                onClick={beginCreate}
              >
                <Plus size={14} />
                <span>New project</span>
              </button>
            )}
          </footer>
        </div>
      )}
    </div>
  )
}

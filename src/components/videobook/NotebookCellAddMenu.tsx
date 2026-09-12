import { useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react'
import {
  Activity,
  AudioWaveform,
  BookOpen,
  ChevronDown,
  CircleDot,
  Film,
  Image,
  Plus,
  Search,
  Video,
  type LucideIcon,
} from 'lucide-react'
import {
  filterNotebookCellAddItems,
  notebookCellAddGroups,
  type NotebookCellAddType,
} from '@/videobook/notebook-cell-add-menu'

const cellPaletteIcons: Record<NotebookCellAddType, LucideIcon> = {
  audio: AudioWaveform,
  image: Image,
  video: Video,
  character: CircleDot,
  prompt: BookOpen,
  analyze: Activity,
  generate_video: Video,
  generate_image: Image,
  generate_audio: AudioWaveform,
  extract_audio: AudioWaveform,
  split_video: Film,
  concat: Film,
  splice: Film,
}

type NotebookCellAddMenuProps = {
  disabled: boolean
  onAdd: (type: NotebookCellAddType) => void | Promise<void>
  onDragEnd: () => void
}

export function NotebookCellAddMenu({
  disabled,
  onAdd,
  onDragEnd,
}: NotebookCellAddMenuProps) {
  const [search, setSearch] = useState('')
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const summaryRef = useRef<HTMLElement>(null)
  const visibleItems = filterNotebookCellAddItems(search)

  const closeMenu = (restoreFocus: boolean) => {
    if (detailsRef.current) detailsRef.current.open = false
    setSearch('')
    if (restoreFocus) {
      window.requestAnimationFrame(() => summaryRef.current?.focus())
    }
  }

  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (!event.currentTarget.open) {
      setSearch('')
      return
    }
    window.requestAnimationFrame(() => searchRef.current?.focus())
  }

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    closeMenu(true)
  }

  const handleAdd = (type: NotebookCellAddType) => {
    closeMenu(true)
    void onAdd(type)
  }

  const handleDragEnd = () => {
    onDragEnd()
    closeMenu(false)
  }

  return (
    <details ref={detailsRef} className="canvas-add-menu" onToggle={handleToggle}>
      <summary ref={summaryRef} aria-label="Add cell" title="Add cell">
        <Plus size={17} />
        <span>Add cell</span>
        <ChevronDown size={13} />
      </summary>
      <div className="canvas-add-popover">
        <label className="canvas-add-search">
          <Search size={14} aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            value={search}
            aria-label="Search cell types"
            placeholder="Search cell types"
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={handleSearchKeyDown}
          />
        </label>
        <div className="canvas-add-results" aria-live="polite">
          {notebookCellAddGroups.map((group) => {
            const items = visibleItems.filter((item) => item.group === group)
            if (items.length === 0) return null
            return (
              <section key={group} className="canvas-add-group">
                <span>{group}</span>
                {items.map((item) => {
                  const Icon = cellPaletteIcons[item.type]
                  return (
                    <button
                      key={item.type}
                      type="button"
                      draggable
                      disabled={disabled}
                      onDragStart={(event) => event.dataTransfer.setData(
                        'application/x-videobook-cell',
                        item.type,
                      )}
                      onDragEnd={handleDragEnd}
                      onClick={() => handleAdd(item.type)}
                    >
                      <Icon size={15} />
                      <span>{item.label}</span>
                    </button>
                  )
                })}
              </section>
            )
          })}
          {visibleItems.length === 0 && (
            <p className="canvas-add-empty">No cell types found</p>
          )}
        </div>
      </div>
    </details>
  )
}

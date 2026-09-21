import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react'
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
  timeline: Film,
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

  const closeMenu = useCallback((restoreFocus: boolean) => {
    if (detailsRef.current) detailsRef.current.open = false
    setSearch('')
    if (restoreFocus) {
      summaryRef.current?.focus()
    }
  }, [])

  useEffect(() => {
    const closeOutside = (event: PointerEvent | FocusEvent) => {
      const menu = detailsRef.current
      if (!menu?.open || !(event.target instanceof Node) || menu.contains(event.target)) return
      closeMenu(false)
    }
    document.addEventListener('pointerdown', closeOutside, true)
    document.addEventListener('focusin', closeOutside)
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true)
      document.removeEventListener('focusin', closeOutside)
    }
  }, [closeMenu])

  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (!event.currentTarget.open) {
      setSearch('')
      return
    }
    const focused = document.activeElement
    if (focused !== summaryRef.current && event.currentTarget.contains(focused)) return
    searchRef.current?.focus()
  }

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDetailsElement>) => {
    if (event.key !== 'Escape' || !detailsRef.current?.open) return
    event.preventDefault()
    event.stopPropagation()
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
    <details
      ref={detailsRef}
      className="canvas-add-menu"
      onToggle={handleToggle}
      onKeyDown={handleMenuKeyDown}
    >
      <summary ref={summaryRef} aria-label="Add cell" title="Add cell">
        <Plus size={15} />
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

import {
  Braces,
  Camera,
  Captions,
  Columns3,
  Copy,
  Download,
  Ellipsis,
  FastForward,
  History,
  Image,
  Images,
  Library,
  Maximize2,
  PanelRightOpen,
  Play,
  Rows3,
  Scissors,
  Sparkles,
  Trash2,
  Upload,
  Video,
  type LucideIcon,
} from 'lucide-react'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'

type NotebookCellContextActionIcon =
  | 'arrange-column'
  | 'arrange-row'
  | 'duplicate'
  | 'download'
  | 'extend-video'
  | 'extract-frame'
  | 'generate-image'
  | 'generate-video'
  | 'generations'
  | 'group-images'
  | 'inspect'
  | 'library'
  | 'media'
  | 'run'
  | 'source'
  | 'split'
  | 'subtitles'
  | 'upload'
  | 'upscale-video'
  | 'more'

export type NotebookCellContextAction = {
  id: string
  label: string
  icon: NotebookCellContextActionIcon
  disabled?: boolean
}

type NotebookCellContextMenuProps = {
  actions: readonly NotebookCellContextAction[]
  address: string
  cellType: string
  deleteDisabled?: boolean
  menuId: string
  /* Accessible name; defaults to the cell wording. Empty grid slots pass
     their own label because no cell backs the menu. */
  menuLabel?: string
  position: { x: number; y: number }
  returnFocus: HTMLElement | null
  onAction: (actionId: string) => void
  onClose: () => void
  /* Omitted for menus with nothing to delete, which also hides the section. */
  onDelete?: () => void
}

const actionIcons: Record<NotebookCellContextActionIcon, LucideIcon> = {
  'arrange-column': Columns3,
  'arrange-row': Rows3,
  duplicate: Copy,
  download: Download,
  'extend-video': FastForward,
  'extract-frame': Camera,
  'generate-image': Image,
  'generate-video': Video,
  generations: History,
  'group-images': Images,
  inspect: PanelRightOpen,
  library: Library,
  media: Maximize2,
  run: Play,
  source: Braces,
  split: Scissors,
  subtitles: Captions,
  upload: Upload,
  'upscale-video': Sparkles,
  more: Ellipsis,
}

function enabledItems(menu: HTMLElement): HTMLButtonElement[] {
  return [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .filter((item) => !item.disabled)
}

export function NotebookCellContextMenu({
  actions,
  address,
  cellType,
  deleteDisabled = false,
  menuId,
  menuLabel,
  position,
  returnFocus,
  onAction,
  onClose,
  onDelete,
}: NotebookCellContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const place = () => {
      const margin = 8
      const left = Math.max(
        margin,
        Math.min(position.x, window.innerWidth - menu.offsetWidth - margin - 1),
      )
      const top = Math.max(
        margin,
        Math.min(position.y, window.innerHeight - menu.offsetHeight - margin - 1),
      )
      menu.style.left = `${left}px`
      menu.style.top = `${top}px`
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(menu)
    enabledItems(menu)[0]?.focus({ preventScroll: true })
    return () => observer.disconnect()
  }, [position.x, position.y])

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node) || menuRef.current?.contains(target)) return
      onClose()
    }
    const closeForViewport = () => onClose()
    document.addEventListener('pointerdown', closeOutside, true)
    window.addEventListener('blur', closeForViewport)
    window.addEventListener('resize', closeForViewport)
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true)
      window.removeEventListener('blur', closeForViewport)
      window.removeEventListener('resize', closeForViewport)
    }
  }, [onClose])

  const restoreFocus = () => {
    onClose()
    if (returnFocus?.isConnected) {
      returnFocus.focus({ preventScroll: true })
    }
  }

  const selectAction = (actionId: string) => {
    onClose()
    onAction(actionId)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const menu = menuRef.current
    if (!menu) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      restoreFocus()
      return
    }
    if (event.key === 'Tab') {
      onClose()
      return
    }
    if (
      onDelete
      && !deleteDisabled
      && (event.key === 'Delete' || event.key === 'Backspace')
    ) {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      onDelete()
      return
    }
    if (
      event.key !== 'ArrowDown'
      && event.key !== 'ArrowUp'
      && event.key !== 'Home'
      && event.key !== 'End'
    ) return
    event.preventDefault()
    event.stopPropagation()
    const items = enabledItems(menu)
    if (items.length === 0) return
    const currentIndex = items.findIndex((item) => item === document.activeElement)
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? (currentIndex + 1 + items.length) % items.length
          : (currentIndex - 1 + items.length) % items.length
    items[nextIndex]?.focus()
  }

  const menu = (
    <div
      ref={menuRef}
      id={menuId}
      className="cell-context-menu"
      data-composer-focus="return"
      role="menu"
      aria-label={menuLabel ?? `Cell actions for ${address}`}
      style={{ left: position.x, top: position.y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={handleKeyDown}
    >
      <div className="cell-context-menu-heading" aria-hidden="true">
        <strong>{address}</strong>
        <span>{cellType}</span>
      </div>
      <div className="cell-context-menu-actions" role="presentation">
        {actions.map((action) => {
          const Icon = actionIcons[action.icon]
          return (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              data-cell-action={action.id}
              data-workspace-action-surface={action.id === 'more' ? 'cell-menu' : undefined}
              disabled={action.disabled}
              onClick={() => selectAction(action.id)}
            >
              <Icon size={15} aria-hidden="true" />
              <span>{action.label}</span>
            </button>
          )
        })}
      </div>
      {onDelete && (
        <div className="cell-context-menu-danger" role="presentation">
          <button
            type="button"
            role="menuitem"
            data-cell-action="delete"
            aria-keyshortcuts="Delete Backspace"
            disabled={deleteDisabled}
            onClick={() => {
              onClose()
              onDelete()
            }}
          >
            <Trash2 size={15} aria-hidden="true" />
            <span>Delete cell</span>
            <kbd>⌫</kbd>
          </button>
        </div>
      )}
    </div>
  )

  return typeof document === 'undefined'
    ? menu
    : createPortal(menu, document.body)
}

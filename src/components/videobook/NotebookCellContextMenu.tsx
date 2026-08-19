import {
  Braces,
  Camera,
  Columns3,
  Copy,
  History,
  Image,
  Library,
  Maximize2,
  PanelRightOpen,
  Play,
  Rows3,
  Scissors,
  Trash2,
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
  | 'extract-frame'
  | 'generate-image'
  | 'generate-video'
  | 'generations'
  | 'inspect'
  | 'library'
  | 'media'
  | 'run'
  | 'source'
  | 'split'

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
  position: { x: number; y: number }
  returnFocus: HTMLElement | null
  onAction: (actionId: string) => void
  onClose: () => void
  onDelete: () => void
}

const actionIcons: Record<NotebookCellContextActionIcon, LucideIcon> = {
  'arrange-column': Columns3,
  'arrange-row': Rows3,
  duplicate: Copy,
  'extract-frame': Camera,
  'generate-image': Image,
  'generate-video': Video,
  generations: History,
  inspect: PanelRightOpen,
  library: Library,
  media: Maximize2,
  run: Play,
  source: Braces,
  split: Scissors,
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
    const margin = 8
    const bounds = menu.getBoundingClientRect()
    const left = Math.max(
      margin,
      Math.min(position.x, window.innerWidth - bounds.width - margin),
    )
    const top = Math.max(
      margin,
      Math.min(position.y, window.innerHeight - bounds.height - margin),
    )
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
  }, [position.x, position.y])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const menu = menuRef.current
      if (!menu) return
      enabledItems(menu)[0]?.focus({ preventScroll: true })
    })
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
      window.cancelAnimationFrame(frame)
      document.removeEventListener('pointerdown', closeOutside, true)
      window.removeEventListener('blur', closeForViewport)
      window.removeEventListener('resize', closeForViewport)
    }
  }, [onClose])

  const restoreFocus = () => {
    onClose()
    if (returnFocus?.isConnected) {
      window.requestAnimationFrame(() => returnFocus.focus({ preventScroll: true }))
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
      !deleteDisabled
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
      role="menu"
      aria-label={`Cell actions for ${address}`}
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
              disabled={action.disabled}
              onClick={() => selectAction(action.id)}
            >
              <Icon size={15} aria-hidden="true" />
              <span>{action.label}</span>
            </button>
          )
        })}
      </div>
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
    </div>
  )

  return typeof document === 'undefined'
    ? menu
    : createPortal(menu, document.body)
}

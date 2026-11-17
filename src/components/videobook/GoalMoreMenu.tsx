import { useRef, type FocusEvent, type KeyboardEvent } from 'react'
import { Ellipsis } from 'lucide-react'

export type GoalMenuItem = {
  label: string
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

export function GoalMoreMenu({ items }: { items: readonly GoalMenuItem[] }) {
  const menu = useRef<HTMLDetailsElement>(null)
  if (items.length === 0) return null
  const close = () => { if (menu.current) menu.current.open = false }
  const leave = (event: FocusEvent<HTMLDetailsElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget instanceof Node ? event.relatedTarget : null)) close()
  }
  const escape = (event: KeyboardEvent<HTMLDetailsElement>) => {
    if (event.key !== 'Escape' || !menu.current?.open) return
    event.stopPropagation()
    close()
    menu.current.querySelector('summary')?.focus()
  }
  return <details ref={menu} className="goal-more" onBlur={leave} onKeyDown={escape}>
    <summary aria-label="More goal actions" title="More goal actions"><Ellipsis size={14} aria-hidden="true" /></summary>
    <div className="goal-more-list">{items.map(item => <button key={item.label} type="button" data-danger={item.danger ? '' : undefined} disabled={item.disabled}
      onClick={() => { close(); item.onSelect() }}>{item.label}</button>)}</div>
  </details>
}

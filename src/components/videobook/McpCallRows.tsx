import { Fragment, useId, useLayoutEffect, useRef } from 'react'
import { ArrowUpRight, X } from 'lucide-react'
import {
  mcpCallState,
  mcpToolLabel,
  type McpCall,
  type McpCallLog,
} from '@/videobook/mcp-activity'

export function McpCallRows({
  log,
  onToggle,
}: {
  log: McpCallLog
  onToggle: (id: number) => void
}) {
  if (log.calls.length === 0) return null
  return (
    <>
      {log.calls.map((call) => (
        <McpCallRow key={call.id} call={call} onToggle={onToggle} />
      ))}
    </>
  )
}

function positionCallDetails(popover: HTMLElement, trigger: HTMLElement) {
  const bounds = trigger.getBoundingClientRect()
  const gutter = 12
  const above = bounds.top > window.innerHeight - bounds.bottom
  const width = Math.min(560, window.innerWidth - gutter * 2)
  popover.style.left = `${Math.max(gutter, Math.min(bounds.left, window.innerWidth - width - gutter))}px`
  popover.style.top = above ? 'auto' : `${bounds.bottom + 8}px`
  popover.style.bottom = above ? `${window.innerHeight - bounds.top + 8}px` : 'auto'
  popover.style.maxHeight = `${Math.max(0, (above ? bounds.top : window.innerHeight - bounds.bottom) - gutter - 8)}px`
}

export function McpCallRow({ call, active = true, onToggle }: {
  call: McpCall
  active?: boolean
  onToggle: (id: number) => void
}) {
  const detailsId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const detailsRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const popover = detailsRef.current
    const trigger = triggerRef.current
    if (!popover || !trigger) return
    if (!active) {
      popover.hidePopover()
      return
    }
    if (!call.expanded) return
    const reposition = () => positionCallDetails(popover, trigger)
    reposition()
    const observer = new ResizeObserver(reposition)
    observer.observe(trigger)
    const history = trigger.closest('.composer-history')
    if (history) observer.observe(history)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [active, call.expanded])

  return (
    <div className={`mcp-call mcp-call-${call.phase}`} data-tool={call.tool}>
      <button
        ref={triggerRef}
        type="button"
        className="composer-history-entry mcp-call-head"
        popoverTarget={detailsId}
        aria-haspopup="dialog"
        aria-controls={detailsId}
        aria-expanded={call.expanded}
      >
        <span className="composer-history-kind mcp-call-channel">ACTION</span>
        <span className="composer-history-text mcp-call-name">{mcpToolLabel(call.tool)}</span>
        <span className="mcp-call-trail">
          {call.phase === 'running' && <span className="mcp-call-signal" aria-hidden="true"><i /><i /><i /></span>}
          <span className="mcp-call-state">{mcpCallState(call)}</span>
          <ArrowUpRight className="mcp-call-details-icon" size={14} aria-hidden="true" />
        </span>
      </button>

      <div
        ref={detailsRef}
        id={detailsId}
        className="mcp-call-popover"
        popover="auto"
        role="dialog"
        aria-label={`${mcpToolLabel(call.tool)} details`}
        onBeforeToggle={(event) => {
          if (event.newState === 'open' && triggerRef.current) positionCallDetails(event.currentTarget, triggerRef.current)
        }}
        onToggle={(event) => {
          if ((event.newState === 'open') !== call.expanded) onToggle(call.id)
        }}
        onKeyDown={(event) => { if (event.key === 'Escape') event.stopPropagation() }}
      >
        <header className="mcp-call-popover-head">
          <span>{mcpToolLabel(call.tool)}</span>
          <button type="button" popoverTarget={detailsId} popoverTargetAction="hide" aria-label="Close action details" autoFocus>
            <X size={14} aria-hidden="true" />
          </button>
        </header>
        <div className="mcp-call-body">
          <p className="mcp-call-what">{call.tool} · {mcpCallState(call)}</p>
          {call.args.length > 0 && (
            <dl className="mcp-call-args">
              {call.args.map((arg) => (
                <Fragment key={arg.name}>
                  <dt>{arg.name}</dt>
                  <dd>{arg.value}</dd>
                </Fragment>
              ))}
            </dl>
          )}
          {call.detail && (
            <p className="mcp-call-out">
              <b aria-hidden="true">&rarr;</b>
              <span>{call.detail}</span>
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

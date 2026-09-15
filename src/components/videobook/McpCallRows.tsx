import { Fragment, useLayoutEffect, useRef } from 'react'
import { ChevronDown } from 'lucide-react'
import {
  mcpCallState,
  mcpToolLabel,
  type McpCall,
  type McpCallLog,
} from '@/videobook/mcp-activity'

const PIN_THRESHOLD_PX = 24

/**
 * The MCP call log, as rows. This is a section of the composer panel like the
 * transcript and the command line, so it carries no border, radius or
 * background of its own -- only the panel's 20px spine.
 */
export function McpCallRows({
  log,
  onToggle,
}: {
  log: McpCallLog
  onToggle: (id: number) => void
}) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const newest = log.calls.at(-1)?.id ?? 0

  // The newest row follows the command line unless the reader has scrolled up
  // to read an older one, which is the same bargain the captions strike.
  useLayoutEffect(() => {
    const element = scrollerRef.current
    if (!element || !pinnedRef.current) return
    element.scrollTop = element.scrollHeight
  }, [newest, log.calls])

  if (log.calls.length === 0) return null

  return (
    <div
      ref={scrollerRef}
      className="mcp-calls"
      data-testid="mcp-calls"
      role="log"
      aria-label="MCP tool calls"
      aria-live="off"
      onScroll={(event) => {
        const element = event.currentTarget
        pinnedRef.current =
          element.scrollHeight - element.scrollTop - element.clientHeight < PIN_THRESHOLD_PX
      }}
    >
      {log.calls.map((call) => (
        <McpCallRow key={call.id} call={call} onToggle={onToggle} />
      ))}
    </div>
  )
}

function McpCallRow({ call, onToggle }: { call: McpCall; onToggle: (id: number) => void }) {
  return (
    <div className={`mcp-call mcp-call-${call.phase}`} data-tool={call.tool}>
      <button
        type="button"
        className="mcp-call-head"
        aria-expanded={call.expanded}
        onClick={() => onToggle(call.id)}
      >
        <span className="mcp-call-signal" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="mcp-call-copy">
          <span className="mcp-call-channel">MCP</span>
          <span className="mcp-call-name">{call.tool}</span>
        </span>
        <span className="mcp-call-trail">
          <span className="mcp-call-state">{mcpCallState(call)}</span>
          <ChevronDown className="mcp-call-chevron" size={13} aria-hidden="true" />
        </span>
      </button>

      {call.expanded && (
        <div className="mcp-call-body">
          <p className="mcp-call-what">{mcpToolLabel(call.tool)}</p>
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
      )}
    </div>
  )
}

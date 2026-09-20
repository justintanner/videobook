import { Fragment } from 'react'
import { ChevronDown } from 'lucide-react'
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

export function McpCallRow({ call, onToggle }: { call: McpCall; onToggle: (id: number) => void }) {
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
          <span className="mcp-call-channel">ACTION</span>
          <span className="mcp-call-name">{call.tool}</span>
        </span>
        <span className="mcp-call-trail">
          <span className="mcp-call-state">{mcpCallState(call)}</span>
          <ChevronDown className="mcp-call-chevron" size={14} aria-hidden="true" />
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

import { useId, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { McpCallRow } from './McpCallRows'
import {
  captionToggleLabel,
  captionsEmptyCopy,
} from '@/videobook/voice-captions'
import {
  composerHistory,
  historyIdle,
  type ComposerHistoryRow,
} from '@/videobook/composer-history'
import type { VoiceCaption, VoicePhase } from '../../../server/src/voice-contract'
import type { McpCallLog } from '@/videobook/mcp-activity'

const PIN_THRESHOLD_PX = 28

export function ComposerHistory({
  captions,
  log,
  phase,
  voicePresent,
  open,
  onToggle,
  onToggleCall,
}: {
  captions: readonly VoiceCaption[]
  log: McpCallLog
  phase: VoicePhase | undefined
  voicePresent: boolean
  open: boolean
  onToggle: () => void
  onToggleCall: (id: number) => void
}) {
  const captionId = useId()
  const scrollerRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const [showLatest, setShowLatest] = useState(false)
  const rows = composerHistory(captions, log)
  const idle = historyIdle(phase, rows.length, voicePresent)

  useLayoutEffect(() => {
    const element = scrollerRef.current
    if (idle || !element || !open) return
    if (pinnedRef.current) element.scrollTop = element.scrollHeight
    const pinned = element.scrollHeight - element.scrollTop - element.clientHeight < PIN_THRESHOLD_PX
    pinnedRef.current = pinned
    setShowLatest(!pinned && rows.length > 0)
  }, [idle, open, rows])

  if (idle) return null

  return (
    <div className="composer-history-panel" data-history-open={open ? 'true' : 'false'}>
      <div
        ref={scrollerRef}
        id={captionId}
        className="composer-history voice-captions"
        data-testid="composer-history"
        hidden={!open}
        aria-label="Chat history"
        role="log"
        aria-live="off"
        onScroll={(event) => {
          const element = event.currentTarget
          const pinned = element.scrollHeight - element.scrollTop - element.clientHeight < PIN_THRESHOLD_PX
          pinnedRef.current = pinned
          setShowLatest(!pinned && rows.length > 0)
        }}
      >
        {rows.length === 0
          ? <p className="voice-captions-empty">{captionsEmptyCopy(phase ?? 'off')}</p>
          : rows.map((row) => <HistoryRow key={rowKey(row)} row={row} onToggleCall={onToggleCall} />)}
      </div>
      {open && showLatest && (
        <button
          type="button"
          className="voice-captions-latest"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            pinnedRef.current = true
            setShowLatest(false)
            const element = scrollerRef.current
            if (element) element.scrollTop = element.scrollHeight
          }}
        >
          Latest
        </button>
      )}
      <button
        type="button"
        className="voice-captions-toggle"
        aria-controls={captionId}
        aria-expanded={open}
        aria-label={captionToggleLabel(open)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onToggle}
      >
        <ChevronDown size={13} aria-hidden="true" />
      </button>
    </div>
  )
}

function rowKey(row: ComposerHistoryRow): string {
  return row.kind === 'caption' ? `caption:${row.caption.id}` : `call:${row.call.id}`
}

function HistoryRow({
  row,
  onToggleCall,
}: {
  row: ComposerHistoryRow
  onToggleCall: (id: number) => void
}) {
  if (row.kind === 'call') {
    return <McpCallRow call={row.call} onToggle={onToggleCall} />
  }
  const caption = row.caption
  return (
    <p data-final={caption.final} data-role={caption.role}>
      <span className="sr-only">{caption.role === 'user' ? 'YOU' : 'COPILOT'}</span>
      <span>{caption.text}{caption.interrupted && <em> · interrupted</em>}</span>
    </p>
  )
}

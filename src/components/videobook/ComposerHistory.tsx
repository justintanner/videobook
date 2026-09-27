import { useContext, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { McpCallRow } from './McpCallRows'
import {
  captionToggleLabel,
  captionsEmptyCopy,
} from '@/videobook/voice-captions'
import {
  historyIdle,
  type ComposerHistoryRow,
} from '@/videobook/composer-history'
import type { VoicePhase } from '../../../server/src/voice-contract'
import { ComposerHistoryChromeContext } from './composer-history-chrome'
import { chatTurnActive, chatTurnLabel } from '@/videobook/chat-turns'
import './ComposerHistory.css'

const PIN_THRESHOLD_PX = 28

export function ComposerHistoryControls() {
  const chrome = useContext(ComposerHistoryChromeContext)
  if (!chrome || chrome.idle || !chrome.hosted) return null
  return (
    <ComposerHistoryControlsStrip
      captionId={chrome.captionId}
      open={chrome.open}
      onToggle={chrome.onToggle}
    />
  )
}

function ComposerHistoryControlsStrip({
  captionId,
  open,
  onToggle,
}: {
  captionId: string
  open: boolean
  onToggle: () => void
}) {
  return (
    <div className="composer-panel-controls">
      <button
        type="button"
        className="voice-captions-toggle"
        data-composer-focus="preserve"
        aria-controls={captionId}
        aria-expanded={open}
        aria-label={captionToggleLabel(open)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onToggle}
      >
        Captain’s Log
      </button>
    </div>
  )
}

export function ComposerHistory({
  rows,
  phase,
  voicePresent,
  open,
  onToggle,
  onToggleCall,
  connected = true,
  onDetailsChange,
  children,
}: {
  rows: readonly ComposerHistoryRow[]
  phase: VoicePhase | undefined
  voicePresent: boolean
  open: boolean
  onToggle: () => void
  onToggleCall: (id: number) => void
  connected?: boolean
  onDetailsChange?: (open: boolean) => void
  children?: ReactNode
}) {
  const localCaptionId = useId()
  const chrome = useContext(ComposerHistoryChromeContext)
  const captionId = chrome?.captionId ?? localCaptionId
  const scrollerRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const newestTurnRef = useRef<number | undefined>(undefined)
  const [showLatest, setShowLatest] = useState(false)
  const idle = !children && historyIdle(phase, rows.length, voicePresent)
  const hosted = Boolean(chrome?.hosted)

  useLayoutEffect(() => {
    const element = scrollerRef.current
    onDetailsChange?.(open && Boolean(element?.querySelector('.chat-turn-details[open]')))
    if (idle || !element || !open) return
    const newestTurn = rows.filter(row => row.kind === 'caption' && row.turn).at(-1)?.sequence
    if (newestTurn !== newestTurnRef.current) pinnedRef.current = true
    newestTurnRef.current = newestTurn
    if (pinnedRef.current) element.scrollTop = element.scrollHeight
    const pinned = element.scrollHeight - element.scrollTop - element.clientHeight < PIN_THRESHOLD_PX
    pinnedRef.current = pinned
    setShowLatest(!pinned && rows.length > 0)
  }, [children, idle, onDetailsChange, open, rows])

  if (idle) return null

  return (
    <div className="composer-history-panel" data-history-open={open ? 'true' : 'false'}>
      {!hosted && (
        <ComposerHistoryControlsStrip
          captionId={captionId}
          open={open}
          onToggle={onToggle}
        />
      )}
      <div
        ref={scrollerRef}
        id={captionId}
        className="composer-history voice-captions"
        data-testid="composer-history"
        hidden={!open}
        aria-label="Captain’s Log"
        role="log"
        aria-live="off"
        onScroll={(event) => {
          const element = event.currentTarget
          const pinned = element.scrollHeight - element.scrollTop - element.clientHeight < PIN_THRESHOLD_PX
          pinnedRef.current = pinned
          setShowLatest(!pinned && rows.length > 0)
        }}
      >
        {rows.length === 0 && !children
          ? <p className="composer-history-entry voice-captions-empty"><span className="composer-history-kind">STATUS</span><span>{captionsEmptyCopy(phase ?? 'off')}</span></p>
          : rows.map((row) => <HistoryRow key={rowKey(row)} row={row} active={open} connected={connected} onToggleCall={onToggleCall}
            onDetailsChange={() => onDetailsChange?.(Boolean(scrollerRef.current?.querySelector('.chat-turn-details[open]')))} />)}
        {children}
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
    </div>
  )
}

function rowKey(row: ComposerHistoryRow): string {
  return row.kind === 'caption' ? `caption:${row.caption.id}` : `call:${row.call.id}`
}

function HistoryRow({
  row,
  active,
  onToggleCall,
  connected,
  onDetailsChange,
}: {
  row: ComposerHistoryRow
  active: boolean
  onToggleCall: (id: number) => void
  connected: boolean
  onDetailsChange: () => void
}) {
  if (row.kind === 'call') {
    return <McpCallRow call={row.call} active={active} onToggle={onToggleCall} />
  }
  const caption = row.caption
  if (row.turn) {
    const turn = row.turn
    const moving = connected && chatTurnActive(turn) && turn.status !== 'review'
    return (
      <article className="chat-turn" data-turn-id={turn.id} data-status={turn.status}>
        <p className="chat-bubble chat-bubble-user" aria-label="Your message">{turn.text}</p>
        <details className="chat-turn-details" onToggle={onDetailsChange}>
          <summary aria-label={`Message activity: ${chatTurnLabel(turn, connected)}`}>
            <span className="chat-turn-status" role="status" aria-live="polite">
              {moving && <span className="chat-working-dots" aria-hidden="true"><i /><i /><i /></span>}
              <span>{chatTurnLabel(turn, connected)}</span>
            </span>
          </summary>
          <div className="chat-turn-work">
            {turn.work.map(work => <p key={work.key}><span>{work.label}</span><span>{work.detail ?? work.state}</span></p>)}
            {row.calls?.map(call => <McpCallRow key={call.id} call={call} active={active} onToggle={onToggleCall} />)}
          </div>
        </details>
        {turn.reply && <p className="chat-bubble chat-bubble-assistant" aria-label="Copilot reply">{turn.reply}</p>}
      </article>
    )
  }
  return (
    <p className={`composer-history-entry chat-bubble chat-bubble-${caption.role}`} data-final={caption.final} data-role={caption.role}>
      <span className="composer-history-kind">{caption.role === 'user' ? 'YOU' : 'COPILOT'}</span>
      <span className="composer-history-text">{caption.text}{caption.interrupted && <em> · interrupted</em>}</span>
    </p>
  )
}

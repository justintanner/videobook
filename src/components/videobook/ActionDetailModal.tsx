import * as Dialog from '@radix-ui/react-dialog'
import { Braces, Clock3, X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { BookCellData } from '@/videobook/project-book'

export type ActionDetailTab = 'history' | 'source'

interface ActionDetailModalProps {
  cell: BookCellData | null
  tab: ActionDetailTab
  onTabChange: (tab: ActionDetailTab) => void
  onClose: () => void
}

interface JsonToken {
  kind: 'boolean' | 'key' | 'null' | 'number' | 'punctuation' | 'string'
  value: string
}

const jsonTokenPattern =
  /("(?:\\.|[^"\\])*")(?=\s*:)|("(?:\\.|[^"\\])*")|\b(true|false)\b|\b(null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g

function trailDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString()
}

function tokenizeJson(value: unknown): JsonToken[] {
  const source = JSON.stringify(value, null, 2) ?? 'null'
  const tokens: JsonToken[] = []
  let cursor = 0

  for (const match of source.matchAll(jsonTokenPattern)) {
    const index = match.index
    if (index > cursor) {
      tokens.push({
        kind: 'punctuation',
        value: source.slice(cursor, index),
      })
    }
    tokens.push({
      kind: match[1]
        ? 'key'
        : match[2]
          ? 'string'
          : match[3]
            ? 'boolean'
            : match[4]
              ? 'null'
              : 'number',
      value: match[0],
    })
    cursor = index + match[0].length
  }

  if (cursor < source.length) {
    tokens.push({
      kind: 'punctuation',
      value: source.slice(cursor),
    })
  }

  return tokens
}

export function RichJson({ value }: { value: unknown }) {
  const tokens = tokenizeJson(value)

  return (
    <pre className="action-detail-json" aria-label="Formatted action source">
      {tokens.map((token, index): ReactNode => (
        <span className={`json-${token.kind}`} key={`${index}-${token.value}`}>
          {token.value}
        </span>
      ))}
    </pre>
  )
}

export function ActionDetailModal({
  cell,
  tab,
  onTabChange,
  onClose,
}: ActionDetailModalProps) {
  return (
    <Dialog.Root
      open={cell !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="action-detail-backdrop" />
        {cell && (
          <Dialog.Content
            className="action-detail-modal"
            aria-describedby="action-detail-description"
          >
            <header className="action-detail-header">
              <div>
                <span>PROJECT BOOK ACTION</span>
                <Dialog.Title>{cell.slug}</Dialog.Title>
                <Dialog.Description id="action-detail-description">
                  {cell.operation}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="action-detail-close"
                  aria-label="Close action details"
                >
                  <X size={20} />
                </button>
              </Dialog.Close>
            </header>

            <div className="action-detail-tabs" role="tablist" aria-label="Action details">
              <button
                type="button"
                role="tab"
                id="action-history-tab"
                aria-controls="action-history-panel"
                aria-selected={tab === 'history'}
                className={tab === 'history' ? 'active' : ''}
                onClick={() => onTabChange('history')}
              >
                <Clock3 size={16} />
                History
                <span>{cell.trail.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                id="action-source-tab"
                aria-controls="action-source-panel"
                aria-selected={tab === 'source'}
                className={tab === 'source' ? 'active' : ''}
                onClick={() => onTabChange('source')}
              >
                <Braces size={17} />
                Source
              </button>
              <div className="action-detail-meta">
                <span>{cell.status}</span>
                <code>{cell.revision.slice(0, 7)}</code>
              </div>
            </div>

            {tab === 'history' ? (
              <section
                className="action-detail-panel"
                role="tabpanel"
                id="action-history-panel"
                aria-labelledby="action-history-tab"
              >
                <ol className="action-detail-history">
                  {cell.trail.map((item, index) => (
                    <li key={item.id}>
                      <span className="action-detail-history-index">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <div>
                        <header>
                          <strong>{item.phase}</strong>
                          <code>{item.revision.slice(0, 7)}</code>
                        </header>
                        <p>{item.title}</p>
                        <small>{item.actor} · {trailDate(item.date)}</small>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            ) : (
              <section
                className="action-detail-panel"
                role="tabpanel"
                id="action-source-panel"
                aria-labelledby="action-source-tab"
              >
                <RichJson value={cell.source} />
              </section>
            )}
          </Dialog.Content>
        )}
      </Dialog.Portal>
    </Dialog.Root>
  )
}

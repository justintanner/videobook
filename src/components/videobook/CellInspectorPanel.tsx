import type { BookCellData } from '@/videobook/project-book'
import { CellInspectorPreview } from './CellInspectorPreview'
import { RichJson } from './RichJson'

export type InspectorTab = 'details' | 'history' | 'source'

interface CellInspectorPanelProps {
  cell: BookCellData
  tab: InspectorTab
  onTabChange: (tab: InspectorTab) => void
  onUpdate: (patch: Partial<BookCellData>) => void
  onCommit: () => void
}

const tabs: Array<{ id: InspectorTab; label: string }> = [
  { id: 'details', label: 'Details' },
  { id: 'history', label: 'History' },
  { id: 'source', label: 'Source' },
]

function trailDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString()
}

export function CellInspectorPanel({
  cell,
  tab,
  onTabChange,
  onUpdate,
  onCommit,
}: CellInspectorPanelProps) {
  const copySlug = async () => {
    try {
      await navigator.clipboard.writeText(cell.slug)
    } catch {
      return
    }
  }

  const copySlugFromKey = (event: React.KeyboardEvent<HTMLHeadingElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    void copySlug()
  }

  return (
    <div className="inspector-body">
      <h2
        className="inspector-slug"
        tabIndex={0}
        title={`Click to copy ${cell.slug}`}
        onClick={() => void copySlug()}
        onKeyDown={copySlugFromKey}
      >
        {cell.slug}
      </h2>
      <div className="inspector-tabs" role="tablist" aria-label="Cell inspector">
        {tabs.map((item) => (
          <button
            type="button"
            role="tab"
            id={`inspector-${item.id}-tab`}
            aria-controls={`inspector-${item.id}-panel`}
            aria-selected={tab === item.id}
            className={tab === item.id ? 'active' : ''}
            key={item.id}
            onClick={() => onTabChange(item.id)}
          >
            {item.label}
            {item.id === 'history' && <span>{cell.trail.length}</span>}
          </button>
        ))}
      </div>

      {tab === 'details' && (
        <section
          className="inspector-tab-panel inspector-details"
          role="tabpanel"
          id="inspector-details-panel"
          aria-labelledby="inspector-details-tab"
        >
          <CellInspectorPreview cell={cell} />
          <label>
            Model
            <select
              value={cell.model ?? 'auto'}
              onChange={(event) => onUpdate({ model: event.target.value })}
              onBlur={onCommit}
            >
              <option value="auto">Auto route</option>
              <option value="nano-banana-pro-google">Nano Banana Pro · Google Flow</option>
              <option value="google-omni">Google Omni · Google Flow</option>
              <option value="seedance">Seedance 2</option>
              <option value="grok">Grok Imagine</option>
            </select>
          </label>
          <div className="input-ports">
            <span>INPUT PORTS</span>
            <p>Drag a source handle into this cell to add an input.</p>
          </div>
        </section>
      )}

      {tab === 'history' && (
        <section
          className="inspector-tab-panel"
          role="tabpanel"
          id="inspector-history-panel"
          aria-labelledby="inspector-history-tab"
        >
          <ol className="inspector-history">
            {cell.trail.map((item, index) => (
              <li key={item.id}>
                <span className="inspector-history-index">
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
      )}

      {tab === 'source' && (
        <section
          className="inspector-tab-panel inspector-source"
          role="tabpanel"
          id="inspector-source-panel"
          aria-labelledby="inspector-source-tab"
        >
          <div className="inspector-source-meta">
            <span>{cell.status}</span>
            <code>{cell.revision.slice(0, 7)}</code>
          </div>
          <RichJson value={cell.source} />
        </section>
      )}
    </div>
  )
}

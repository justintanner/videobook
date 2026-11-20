import type { NotebookCell } from 'videobook-engine'
import { notebookGridTag } from 'videobook-engine/notebook-grid'
import {
  takeStatusText,
  type GenerationTake,
  type TakesTotal,
} from '@/videobook/generation-takes'

type TakesProps = {
  producer: NotebookCell
  takes: readonly GenerationTake[]
  total: TakesTotal | null
  onSelectCell?: (cellId: string) => void
}

function statusTone(take: GenerationTake): string {
  if (take.status === 'failed') return 'failed'
  if (take.status !== 'completed') return 'running'
  return take.current ? 'current' : 'done'
}

function TakeRow({ take, noun, onSelectCell }: {
  take: GenerationTake
  noun: 'clip' | 'image'
  onSelectCell?: (cellId: string) => void
}) {
  const cellId = take.outputCellId
  return (
    <button
      type="button"
      className="inspector-take"
      aria-current={take.current ? 'true' : undefined}
      disabled={!cellId || !onSelectCell}
      onClick={() => {
        if (cellId) onSelectCell?.(cellId)
      }}
    >
      {take.thumbnailUrl
        ? <img className="inspector-take-thumb" src={take.thumbnailUrl} alt="" loading="lazy" />
        : <span className="inspector-take-thumb inspector-take-thumb-empty" aria-hidden="true" />}
      <span className="inspector-take-address">{take.address ?? 'Removed'}</span>
      <span className="inspector-take-body">
        <span className="inspector-take-model" title={take.modelTitle ?? undefined}>
          {take.model ?? 'Unknown model'}
        </span>
        <span className={`inspector-take-status inspector-take-status-${statusTone(take)}`}>
          {takeStatusText(take, noun)}
        </span>
      </span>
      <span className={`inspector-take-cost inspector-take-cost-${take.cost.state}`}>
        {take.cost.amount ?? '—'}
      </span>
    </button>
  )
}

/** Each run of a producer with the output it made and what it cost. */
export function GenerationTakes({ producer, takes, total, onSelectCell }: TakesProps) {
  const tag = notebookGridTag(producer.slot)
  const noun = producer.type === 'generate_image' ? 'image' : 'clip'
  return (
    <section className="inspector-takes" aria-label={`Takes from ${tag}`}>
      <header className="inspector-takes-head">
        <span className="inspector-media-field-label">{`Takes from ${tag}`}</span>
        <span className="inspector-takes-count">
          {takes.length === 1 ? '1 run' : `${takes.length} runs`}
        </span>
      </header>
      <ol className="inspector-takes-list">
        {takes.map((take) => (
          <li key={take.attemptId}>
            <TakeRow take={take} noun={noun} onSelectCell={onSelectCell} />
          </li>
        ))}
      </ol>
      {total && (
        <footer className="inspector-takes-total">
          <span>{`${tag} total`}</span>
          <span>
            <strong>{total.billed}</strong>
            {` billed${total.pending ? ` · ${total.pending} pending` : ''}`}
          </span>
        </footer>
      )}
    </section>
  )
}

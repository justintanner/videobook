import { ArrowRight } from 'lucide-react'
import { Suspense, use } from 'react'
import type { NotebookCell } from 'videobook-engine'
import { notebookGridTag } from 'videobook-engine/notebook-grid'
import { CellUsageCost } from './CellUsageCost'
import { GeneratingPrompt } from './GeneratingRunDetails'
import { formatMediaTime } from '@/videobook/notebook-cell-presentation'
import {
  generationModelLabel,
  generationProviderLabel,
  generationRunSeconds,
  producingGeneration,
  type GenerationAttemptRecord,
  type OutputGeneration,
} from '@/videobook/output-generation'

export type LoadCellGenerations = (
  cellId: string,
) => Promise<readonly GenerationAttemptRecord[]>

type CallTool = (
  tool: string,
  args: Record<string, unknown>,
  options?: { background?: boolean },
) => Promise<unknown>

type MadeWithOutcome = { generation: OutputGeneration | null; readable: boolean }

type MadeWithState = 'loading' | 'ready' | 'unreadable'

type MadeWithProps = {
  producer: NotebookCell
  outputCellId: string
  outputArtifactId: string | null
  bookId: string
  call?: CallTool
  load?: LoadCellGenerations
  onSelectSource?: (cellId: string) => void
}

// One promise per loader, cell and artifact so `use()` sees a stable value;
// a regenerated output has a new artifact id and reads again.
const outcomeCache = new WeakMap<LoadCellGenerations, Map<string, Promise<MadeWithOutcome>>>()

function cachedOutcome(
  load: LoadCellGenerations,
  cellId: string,
  artifactId: string,
): Promise<MadeWithOutcome> {
  const byKey = outcomeCache.get(load) ?? new Map<string, Promise<MadeWithOutcome>>()
  outcomeCache.set(load, byKey)
  const key = `${cellId}:${artifactId}`
  const cached = byKey.get(key)
  if (cached) return cached
  const pending = load(cellId).then(
    (attempts): MadeWithOutcome => ({ generation: producingGeneration(attempts, artifactId), readable: true }),
    (): MadeWithOutcome => ({ generation: null, readable: false }),
  )
  byKey.set(key, pending)
  return pending
}

export function GenerationProducerLink({
  producer,
  onSelectSource,
}: {
  producer: NotebookCell
  onSelectSource?: (cellId: string) => void
}) {
  return (
    <button
      type="button"
      className="inspector-generation-from-link"
      onClick={() => onSelectSource?.(producer.id)}
    >
      <span className="inspector-generation-from-tag">
        {notebookGridTag(producer.slot)}
      </span>
      <span>{`Generate ${producer.type === 'generate_image' ? 'image' : 'video'}`}</span>
      <ArrowRight size={12} aria-hidden="true" />
    </button>
  )
}

function runDateLabel(time: number): string {
  return new Date(time).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

type MadeWithFacts = {
  provider: string | null
  model: string | null
  written: string | null
  sent: string | null
}

function madeWithFacts(producer: NotebookCell, generation: OutputGeneration | null): MadeWithFacts {
  if (generation) {
    return {
      provider: generation.provider,
      model: generation.model,
      written: generation.prompt,
      sent: generation.resolvedPrompt,
    }
  }
  return {
    provider: producer.provider ?? null,
    model: producer.model ?? null,
    written: producer.prompt ?? null,
    sent: null,
  }
}

function MadeWithIdentity({ facts, generation }: { facts: MadeWithFacts; generation: OutputGeneration | null }) {
  const provider = generationProviderLabel(facts.provider)
  const model = generationModelLabel(facts.model, facts.provider)
  if (!provider && !model) return null
  return (
    <div className="inspector-made-with-identity">
      {provider && <span className="inspector-made-with-provider">{provider}</span>}
      {model && <strong className="inspector-made-with-model" title={facts.model ?? undefined}>{model}</strong>}
      {generation && (
        <time
          className="inspector-made-with-date"
          dateTime={new Date(generation.startedAt).toISOString()}
        >
          {runDateLabel(generation.startedAt)}
        </time>
      )}
    </div>
  )
}

function MadeWithNote({ state, producer, generation }: {
  state: MadeWithState
  producer: NotebookCell
  generation: OutputGeneration | null
}) {
  if (state === 'loading') {
    return <p className="inspector-made-with-note" role="status">Reading the run that made this…</p>
  }
  if (generation) return null
  const reason = state === 'unreadable'
    ? 'Could not read the run that made this.'
    : 'No recorded run for this output.'
  return (
    <p className="inspector-made-with-note">
      {`${reason} Showing ${notebookGridTag(producer.slot)}’s current settings.`}
    </p>
  )
}

function MadeWithFooter({ generation, producer, bookId, call }: {
  generation: OutputGeneration | null
  producer: NotebookCell
  bookId: string
  call?: CallTool
}) {
  const seconds = generation ? generationRunSeconds(generation) : null
  return (
    <div className="inspector-made-with-footer">
      {seconds !== null && (
        <span className="inspector-made-with-duration">
          Took {formatMediaTime(Math.round(seconds))}
        </span>
      )}
      {generation?.runId
        ? <CellUsageCost bookId={bookId} call={call} cellId={null} runId={generation.runId} />
        : <CellUsageCost bookId={bookId} call={call} cellId={producer.id} />}
    </div>
  )
}

/** Provider, model and prompt of the run that produced a generated output. */
function MadeWithCard({
  producer,
  generation,
  state,
  bookId,
  call,
  onSelectSource,
}: Omit<MadeWithProps, 'outputCellId' | 'outputArtifactId' | 'load'> & {
  generation: OutputGeneration | null
  state: MadeWithState
}) {
  const facts = madeWithFacts(producer, generation)
  const loading = state === 'loading'
  return (
    <section className="inspector-made-with" aria-label="Made with" aria-busy={loading}>
      <header className="inspector-made-with-head">
        <span className="inspector-media-field-label">Made with</span>
        <GenerationProducerLink producer={producer} onSelectSource={onSelectSource} />
      </header>
      {!loading && <MadeWithIdentity facts={facts} generation={generation} />}
      <MadeWithNote state={state} producer={producer} generation={generation} />
      {!loading && <GeneratingPrompt written={facts.written} sent={facts.sent} />}
      {!loading && (
        <MadeWithFooter generation={generation} producer={producer} bookId={bookId} call={call} />
      )}
    </section>
  )
}

function LoadedMadeWith({ promise, ...props }: Omit<MadeWithProps, 'outputCellId' | 'outputArtifactId' | 'load'> & {
  promise: Promise<MadeWithOutcome>
}) {
  const { generation, readable } = use(promise)
  return <MadeWithCard {...props} generation={generation} state={readable ? 'ready' : 'unreadable'} />
}

export function GenerationMadeWith({
  outputCellId,
  outputArtifactId,
  load,
  ...props
}: MadeWithProps) {
  if (!load || !outputArtifactId) {
    return <MadeWithCard {...props} generation={null} state="ready" />
  }
  const promise = cachedOutcome(load, outputCellId, outputArtifactId)
  return (
    <Suspense fallback={<MadeWithCard {...props} generation={null} state="loading" />}>
      <LoadedMadeWith {...props} promise={promise} />
    </Suspense>
  )
}

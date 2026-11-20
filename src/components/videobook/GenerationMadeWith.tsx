import { ArrowRight } from 'lucide-react'
import { Suspense, use, useDeferredValue, type ReactNode } from 'react'
import type { NotebookCell, NotebookEdge } from 'videobook-engine'
import { notebookGridTag } from 'videobook-engine/notebook-grid'
import { CellUsageCost } from './CellUsageCost'
import { GeneratingPrompt } from './GeneratingRunDetails'
import { GenerationTakes } from './GenerationTakes'
import { UsageCostSummary } from './UsageCost'
import { formatMediaTime } from '@/videobook/notebook-cell-presentation'
import { generationTakes, producerOutputsSignature, takesTotal } from '@/videobook/generation-takes'
import {
  generationModelLabel,
  generationProviderLabel,
  generationRunSeconds,
  producingGeneration,
  type GenerationAttemptRecord,
  type OutputGeneration,
} from '@/videobook/output-generation'
import { useBookUsage } from '@/videobook/useBookUsage'

export type LoadCellGenerations = (
  cellId: string,
) => Promise<readonly GenerationAttemptRecord[]>

type CallTool = (
  tool: string,
  args: Record<string, unknown>,
  options?: { background?: boolean },
) => Promise<unknown>

type MadeWithOutcome = { attempts: readonly GenerationAttemptRecord[]; readable: boolean }

type MadeWithState = 'loading' | 'ready' | 'unreadable'

type MadeWithProps = {
  producer: NotebookCell
  outputCellId: string
  outputArtifactId: string | null
  bookId: string
  call?: CallTool
  load?: LoadCellGenerations
  onSelectSource?: (cellId: string) => void
  /** The notebook graph, to place each take at its output's grid address. */
  cells?: readonly NotebookCell[]
  edges?: readonly NotebookEdge[]
}

type CachedOutcome = { signature: string; promise: Promise<MadeWithOutcome> }

// One promise per loader and producer so `use()` sees a stable value; it is
// read again when the output on screen or any output of the producer changes.
const outcomeCache = new WeakMap<LoadCellGenerations, Map<string, CachedOutcome>>()

function cachedOutcome(
  load: LoadCellGenerations,
  producerId: string,
  signature: string,
): Promise<MadeWithOutcome> {
  const byProducer = outcomeCache.get(load) ?? new Map<string, CachedOutcome>()
  outcomeCache.set(load, byProducer)
  const cached = byProducer.get(producerId)
  if (cached?.signature === signature) return cached.promise
  const promise = load(producerId).then(
    (attempts): MadeWithOutcome => ({ attempts, readable: true }),
    (): MadeWithOutcome => ({ attempts: [], readable: false }),
  )
  byProducer.set(producerId, { signature, promise })
  return promise
}

async function usageUnavailable(): Promise<unknown> {
  throw new Error('Usage is unavailable')
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

function fallbackCost({ generation, producer, bookId, call }: {
  generation: OutputGeneration | null
  producer: NotebookCell
  bookId: string
  call?: CallTool
}): ReactNode {
  return generation?.runId
    ? <CellUsageCost bookId={bookId} call={call} cellId={null} runId={generation.runId} />
    : <CellUsageCost bookId={bookId} call={call} cellId={producer.id} />
}

function MadeWithFooter({ generation, cost }: {
  generation: OutputGeneration | null
  cost: ReactNode
}) {
  const seconds = generation ? generationRunSeconds(generation) : null
  return (
    <div className="inspector-made-with-footer">
      {seconds !== null && (
        <span className="inspector-made-with-duration">
          Took {formatMediaTime(Math.round(seconds))}
        </span>
      )}
      {cost}
    </div>
  )
}

/** Provider, model and prompt of the run that produced a generated output. */
function MadeWithCard({
  producer,
  generation,
  state,
  cost,
  onSelectSource,
}: {
  producer: NotebookCell
  generation: OutputGeneration | null
  state: MadeWithState
  cost: ReactNode
  onSelectSource?: (cellId: string) => void
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
      {!loading && <MadeWithFooter generation={generation} cost={cost} />}
    </section>
  )
}

/** The card with this run's cost beside every run of the producer. */
function MadeWithAndTakes({
  attempts,
  generation,
  producer,
  outputCellId,
  outputArtifactId,
  cells,
  bookId,
  call,
  onSelectSource,
}: Omit<MadeWithProps, 'load' | 'edges'> & {
  attempts: readonly GenerationAttemptRecord[]
  generation: OutputGeneration | null
}) {
  const runId = generation?.runId ?? null
  const usage = useBookUsage({
    bookId,
    ready: Boolean(call),
    call: call ?? usageUnavailable,
    cellId: producer.id,
    runId,
  })
  const run = runId && usage.snapshot?.run?.id === runId ? usage.snapshot.run : null
  const producerUsage = usage.snapshot?.cell?.id === producer.id ? usage.snapshot.cell : null
  const takes = generationTakes(attempts, {
    cells: cells ?? [],
    outputCellId,
    outputArtifactId,
    runs: producerUsage?.runs ?? [],
  })
  const cost = run
    ? <div className="usage-cost-scopes"><UsageCostSummary label="Run cost" totals={run.totals} calls={run.calls} /></div>
    : null
  return (
    <>
      <MadeWithCard
        producer={producer}
        generation={generation}
        state="ready"
        cost={cost}
        onSelectSource={onSelectSource}
      />
      <GenerationTakes
        producer={producer}
        takes={takes}
        total={takesTotal(producerUsage?.totals ?? null)}
        onSelectCell={onSelectSource}
      />
    </>
  )
}

function LoadedMadeWith({ promise, ...props }: Omit<MadeWithProps, 'load' | 'edges'> & {
  promise: Promise<MadeWithOutcome>
}) {
  const { attempts, readable } = use(promise)
  const generation = props.outputArtifactId
    ? producingGeneration(attempts, props.outputArtifactId)
    : null
  if (readable && attempts.length > 0) {
    return <MadeWithAndTakes {...props} attempts={attempts} generation={generation} />
  }
  return (
    <MadeWithCard
      producer={props.producer}
      generation={generation}
      state={readable ? 'ready' : 'unreadable'}
      cost={fallbackCost({ ...props, generation })}
      onSelectSource={props.onSelectSource}
    />
  )
}

export function GenerationMadeWith({ load, edges, ...props }: MadeWithProps) {
  const signature = `${props.outputArtifactId ?? ''}|${producerOutputsSignature(
    props.producer.id,
    props.cells ?? [],
    edges ?? [],
  )}`
  const promise = load ? cachedOutcome(load, props.producer.id, signature) : null
  const shown = useDeferredValue(promise)
  const fallback = (state: MadeWithState) => (
    <MadeWithCard
      producer={props.producer}
      generation={null}
      state={state}
      cost={fallbackCost({ ...props, generation: null })}
      onSelectSource={props.onSelectSource}
    />
  )
  if (!shown) return fallback('ready')
  return (
    <Suspense fallback={fallback('loading')}>
      <LoadedMadeWith {...props} promise={shown} />
    </Suspense>
  )
}

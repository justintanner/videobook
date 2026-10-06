import { Check, Copy, RotateCcw } from 'lucide-react'
import { Suspense, startTransition, use, useState, type ReactNode } from 'react'
import type { ArtifactThumbAsset } from './ArtifactThumb'
import { RichJson } from './RichJson'
import { formatMediaTime } from '@/videobook/notebook-cell-presentation'
import { useElapsedSeconds } from '@/videobook/use-elapsed-seconds'
import {
  generatingTimeline,
  generationPayloadSentPrompt,
  generationPayloadSettings,
  type GeneratingTimelineStep,
  type GenerationRequestInspection,
} from '@/videobook/generation-request-inspection'

export type InspectGenerationRequest = (
  artifactId: string,
) => Promise<GenerationRequestInspection>

export type GeneratingRunKind = 'queued' | 'generating' | 'failed'

type InspectionOutcome =
  | { ok: true; inspection: GenerationRequestInspection }
  | { ok: false; message: string }

export type GeneratingRunFacts = {
  runKind: GeneratingRunKind
  startedAt: string | null
  provider: string | null
  model: string | null
  runId: string | null
  jobNumber: number | null
  providerArtifactId: string | null
  writtenPrompt: string | null
}

// One promise per loader and key so `use()` sees a stable value across
// renders; the key carries the run phase and an explicit refresh count.
const inspectionCache = new WeakMap<
  InspectGenerationRequest,
  Map<string, Promise<InspectionOutcome>>
>()

function cachedInspection(
  inspect: InspectGenerationRequest,
  artifactId: string,
  key: string,
): Promise<InspectionOutcome> {
  const byKey = inspectionCache.get(inspect) ?? new Map()
  inspectionCache.set(inspect, byKey)
  const cached = byKey.get(key)
  if (cached) return cached
  const pending = inspect(artifactId).then(
    (inspection): InspectionOutcome => ({ ok: true, inspection }),
    (error: unknown): InspectionOutcome => ({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }),
  )
  byKey.set(key, pending)
  return pending
}

function clockTime(iso: string | null): string | null {
  if (!iso) return null
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return null
  return new Date(time).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="inspector-generating-copy"
      aria-label={label}
      title={label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied
        ? <Check size={12} aria-hidden="true" />
        : <Copy size={12} aria-hidden="true" />}
    </button>
  )
}

function TimelineStepDetail({
  step,
  submittedAt,
}: {
  step: GeneratingTimelineStep
  submittedAt: string | null
}) {
  const sinceSubmit = useElapsedSeconds(
    step.id === 'generating' && step.status === 'active' ? submittedAt : null,
  )
  if (sinceSubmit !== null) {
    return <span>{formatMediaTime(sinceSubmit)} so far</span>
  }
  const time = step.id === 'generating' ? null : clockTime(step.at)
  if (time) return <time dateTime={step.at ?? undefined}>{time}</time>
  return <span>{step.status === 'pending' ? 'pending' : step.status}</span>
}

function GeneratingTimeline({
  facts,
  inspection,
}: {
  facts: GeneratingRunFacts
  inspection: GenerationRequestInspection | null
}) {
  const steps = generatingTimeline({
    runKind: facts.runKind,
    startedAt: facts.startedAt,
    task: inspection?.task ?? null,
  })
  return (
    <div className="inspector-generating-section">
      <span className="inspector-media-field-label">Timeline</span>
      <ol className="inspector-generating-timeline">
        {steps.map((step) => (
          <li key={step.id} data-status={step.status}>
            <span className="inspector-generating-timeline-bar" aria-hidden="true" />
            <strong>{step.label}</strong>
            <TimelineStepDetail
              step={step}
              submittedAt={inspection?.task?.submittedAt ?? null}
            />
          </li>
        ))}
      </ol>
    </div>
  )
}

type FactRow = { label: string; value: string; title?: string; copy?: string }

function runFactRows(
  facts: GeneratingRunFacts,
  inspection: GenerationRequestInspection | null,
): FactRow[] {
  const payloadModel = inspection?.payload
    && typeof inspection.payload === 'object'
    && typeof (inspection.payload as { model?: unknown }).model === 'string'
    ? (inspection.payload as { model: string }).model
    : null
  const model = payloadModel ?? facts.model
  const task = inspection?.task ?? null
  const rows: (FactRow | null)[] = [
    {
      label: 'Provider · model',
      value: [facts.provider, model].filter(Boolean).join(' · ') || '—',
    },
    inspection?.taskType
      ? { label: 'Task type', value: inspection.taskType }
      : null,
    task
      ? {
          label: 'Provider task',
          value: shortId(task.taskId),
          title: task.taskId,
          copy: task.taskId,
        }
      : null,
    facts.runId
      ? {
          label: 'Run',
          value: shortId(facts.runId),
          title: facts.runId,
          copy: facts.runId,
        }
      : null,
    facts.jobNumber !== null
      ? { label: 'Job', value: `#${facts.jobNumber}` }
      : null,
    facts.providerArtifactId
      ? {
          label: 'Request artifact',
          value: shortId(facts.providerArtifactId),
          title: facts.providerArtifactId,
          copy: facts.providerArtifactId,
        }
      : null,
  ]
  return rows.filter((row): row is FactRow => row !== null)
}

function GeneratingRunFactsGrid({
  facts,
  inspection,
}: {
  facts: GeneratingRunFacts
  inspection: GenerationRequestInspection | null
}) {
  const settings = generationPayloadSettings(inspection?.payload ?? null)
  return (
    <div className="inspector-generating-section">
      <span className="inspector-media-field-label">Run</span>
      <dl className="inspector-generating-facts">
        {runFactRows(facts, inspection).map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd title={row.title}>
              <span>{row.value}</span>
              {row.copy && (
                <CopyButton text={row.copy} label={`Copy ${row.label.toLowerCase()}`} />
              )}
            </dd>
          </div>
        ))}
      </dl>
      {settings.length > 0 && (
        <ul className="inspector-generating-settings" aria-label="Request settings">
          {settings.map((setting) => (
            <li key={setting.key}>
              <span>{setting.key.replace(/_/g, ' ')}</span> {setting.value}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function GeneratingPrompt({
  written,
  sent,
}: {
  written: string | null
  sent: string | null
}) {
  const [showSent, setShowSent] = useState(false)
  const canCompare = Boolean(written && sent && written !== sent)
  const text = (showSent && canCompare ? sent : written ?? sent) ?? ''
  if (!text) return null
  return (
    <div className="inspector-generating-section inspector-media-generating-prompt">
      <div className="inspector-generating-prompt-head">
        <span className="inspector-media-field-label">Prompt</span>
        {canCompare && (
          <div className="inspector-generating-toggle" role="group" aria-label="Prompt version">
            <button type="button" aria-pressed={!showSent} onClick={() => setShowSent(false)}>
              As written
            </button>
            <button type="button" aria-pressed={showSent} onClick={() => setShowSent(true)}>
              As sent
            </button>
          </div>
        )}
      </div>
      <blockquote>{text}</blockquote>
    </div>
  )
}

function payloadEmptyMessage(
  facts: GeneratingRunFacts,
  outcome: InspectionOutcome | null,
): string {
  if (outcome && !outcome.ok) return outcome.message
  if (outcome?.ok && outcome.inspection.errorMessage) {
    return outcome.inspection.errorMessage
  }
  if (facts.runKind === 'queued') {
    return 'The request is recorded once the run submits it to the provider.'
  }
  return 'No provider request was recorded for this run.'
}

function GeneratingPayloadPanel({
  facts,
  outcome,
  loading,
  artifactAssets,
  onRefresh,
}: {
  facts: GeneratingRunFacts
  outcome: InspectionOutcome | null
  loading: boolean
  artifactAssets?: ReadonlyMap<string, ArtifactThumbAsset>
  onRefresh?: () => void
}) {
  const inspection = outcome?.ok ? outcome.inspection : null
  const payload = inspection?.payload ?? null
  const submitted = clockTime(inspection?.task?.submittedAt ?? null)
  return (
    <aside className="inspector-generating-payload" aria-busy={loading}>
      <header className="inspector-generating-payload-head">
        <span className="inspector-media-field-label">Request payload</span>
        {inspection?.taskType && <code>{inspection.taskType}</code>}
        {submitted && <span className="inspector-generating-muted">sent {submitted}</span>}
        <span className="inspector-generating-spacer" />
        {onRefresh && (
          <button
            type="button"
            className="inspector-generating-copy"
            aria-label="Reload request payload"
            title="Reload request payload"
            disabled={loading}
            onClick={onRefresh}
          >
            <RotateCcw size={12} aria-hidden="true" />
          </button>
        )}
        {payload !== null && (
          <CopyButton text={JSON.stringify(payload, null, 2)} label="Copy request JSON" />
        )}
      </header>
      {payload !== null
        ? (
          <div className="inspector-generating-payload-scroll" tabIndex={0}>
            <RichJson
              value={payload}
              ariaLabel="Provider request payload"
              artifactAssets={artifactAssets}
              mediaDisplay="preview"
              remoteMedia
            />
          </div>
        )
        : (
          <p className="inspector-analysis-json-status" role="status">
            {loading ? 'Loading request payload…' : payloadEmptyMessage(facts, outcome)}
          </p>
        )}
    </aside>
  )
}

type ColumnsProps = {
  facts: GeneratingRunFacts
  header: ReactNode
  footer?: ReactNode
  artifactAssets?: ReadonlyMap<string, ArtifactThumbAsset>
  onRefresh?: () => void
}

function GeneratingRunColumnsView({
  facts,
  header,
  footer,
  artifactAssets,
  outcome,
  loading,
  onRefresh,
}: ColumnsProps & { outcome: InspectionOutcome | null; loading: boolean }) {
  const inspection = outcome?.ok ? outcome.inspection : null
  return (
    <>
      <div className="inspector-media-generating-summary">
        {header}
        <GeneratingTimeline facts={facts} inspection={inspection} />
        <GeneratingRunFactsGrid facts={facts} inspection={inspection} />
        <GeneratingPrompt
          written={facts.writtenPrompt}
          sent={generationPayloadSentPrompt(inspection?.payload ?? null)}
        />
        {footer}
      </div>
      <GeneratingPayloadPanel
        facts={facts}
        outcome={outcome}
        loading={loading}
        artifactAssets={artifactAssets}
        onRefresh={onRefresh}
      />
    </>
  )
}

function LoadedGeneratingRunColumns({
  promise,
  ...props
}: ColumnsProps & { promise: Promise<InspectionOutcome> }) {
  const outcome = use(promise)
  return <GeneratingRunColumnsView {...props} outcome={outcome} loading={false} />
}

/**
 * Summary and payload columns for a run still in flight. The provider request
 * is read once per run phase; Reload asks again (for example after submit).
 */
export function GeneratingRunColumns({
  inspect,
  ...props
}: ColumnsProps & { inspect?: InspectGenerationRequest }) {
  const [refreshCount, setRefreshCount] = useState(0)
  const artifactId = props.facts.providerArtifactId
  if (!inspect || !artifactId) {
    return <GeneratingRunColumnsView {...props} outcome={null} loading={false} />
  }
  const promise = cachedInspection(
    inspect,
    artifactId,
    `${artifactId}:${props.facts.runKind}:${refreshCount}`,
  )
  // A transition keeps the current payload on screen while the reload runs.
  const onRefresh = () => startTransition(() => setRefreshCount((count) => count + 1))
  return (
    <Suspense
      fallback={<GeneratingRunColumnsView {...props} outcome={null} loading onRefresh={onRefresh} />}
    >
      <LoadedGeneratingRunColumns {...props} promise={promise} onRefresh={onRefresh} />
    </Suspense>
  )
}

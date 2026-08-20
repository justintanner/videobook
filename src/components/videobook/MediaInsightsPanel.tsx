import { useState, type ReactNode } from 'react'
import {
  Captions,
  Check,
  CircleAlert,
  Copy,
  Download,
  RefreshCw,
} from 'lucide-react'
import {
  canDownloadTranscriptSrt,
  ELEVENLABS_TRANSCRIPT_CARD_TITLE,
  PLAIN_TRANSCRIPT_CARD_TITLE,
  resolveTranscriptCardView,
  transcriptHasText,
  transcriptSourceBody,
  transcriptSourceCopyText,
  transcriptSourceEmptyMessage,
  transcriptSourceMeta,
  type MediaTranscript,
  type MediaTranscriptSources,
  type TranscriptCardView,
  type TranscriptSidecarSource,
} from '@/videobook/media-insights'

type CopyState = 'idle' | 'copied' | 'failed'

export type MediaInsightsPanelProps = {
  artifactId: string
  transcript: MediaTranscriptSources | null
  busy: boolean
  transcribing: boolean
  error: string | null
  onTranscribe?: () => void
  onLoadTranscriptJson?: (
    source: TranscriptSidecarSource,
  ) => Promise<{ text: string; file: string }>
  onDownloadTranscriptSrt?: () => void
}

function copyLabel(state: CopyState): string {
  if (state === 'copied') return 'Copied'
  return state === 'failed' ? 'Retry' : 'Copy'
}

function TranscriptText({ text, label }: { text: string; label: string }) {
  return (
    <pre
      className="inspector-transcript-text"
      tabIndex={0}
      aria-label={label}
    >
      {text}
    </pre>
  )
}

function InsightRerunButton({
  label,
  running,
  disabled,
  onClick,
}: {
  label: string
  running: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="inspector-insight-rerun"
      aria-label={label}
      title={label}
      aria-busy={running}
      disabled={disabled}
      onClick={onClick}
    >
      <RefreshCw size={12} aria-hidden="true" />
    </button>
  )
}

function InsightStartButton({
  icon,
  label,
  runningLabel,
  running,
  disabled,
  onClick,
}: {
  icon: ReactNode
  label: string
  runningLabel: string
  running: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="inspector-insight-action"
      aria-busy={running}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      <span>{running ? runningLabel : label}</span>
    </button>
  )
}

function TranscriptSourceCard({
  source,
  title,
  transcript,
  busy,
  transcribing,
  onTranscribe,
  onLoadTranscriptJson,
  onDownloadTranscriptSrt,
}: {
  source: TranscriptSidecarSource
  title: string
  transcript: MediaTranscript | null
  busy: boolean
  transcribing?: boolean
  onTranscribe?: () => void
  onLoadTranscriptJson?: MediaInsightsPanelProps['onLoadTranscriptJson']
  onDownloadTranscriptSrt?: () => void
}) {
  const [requestedView, setRequestedView] = useState<TranscriptCardView | null>(
    null,
  )
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const [jsonText, setJsonText] = useState<string | null>(null)
  const [jsonFile, setJsonFile] = useState<string | null>(null)
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [jsonLoading, setJsonLoading] = useState(false)
  const view = resolveTranscriptCardView(transcript, requestedView)
  const hasText = transcriptHasText(transcript)
  const showSrt = source === 'elevenlabs'
  const transcribe = source === 'elevenlabs' ? onTranscribe : undefined
  const canDownload = showSrt && canDownloadTranscriptSrt(transcript)
  const body = transcriptSourceBody({
    source,
    transcript,
    view,
    jsonText,
  })
  const meta = transcriptSourceMeta({
    transcript,
    view,
    jsonFile,
  })
  const copyText = transcriptSourceCopyText({
    source,
    transcript,
    view,
    jsonText,
  })
  const emptyMessage = transcriptSourceEmptyMessage({
    source,
    transcript,
    view,
    jsonLoading,
    jsonError,
    body,
  })
  const jsonEnabled = Boolean(transcript)
  const canCopy = Boolean(copyText)

  const copy = async () => {
    if (!copyText) return
    try {
      await navigator.clipboard.writeText(copyText)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  const selectView = (next: TranscriptCardView) => {
    if (next === 'json' && !jsonEnabled) return
    setRequestedView(next)
    if (
      next !== 'json'
      || jsonText !== null
      || jsonLoading
      || !onLoadTranscriptJson
    ) {
      return
    }
    setJsonLoading(true)
    setJsonError(null)
    void onLoadTranscriptJson(source)
      .then((result) => {
        setJsonText(result.text)
        setJsonFile(result.file)
      })
      .catch((error: unknown) => {
        setJsonError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        setJsonLoading(false)
      })
  }

  return (
    <section className="inspector-insight-block" aria-label={title}>
      <header className="inspector-insight-header">
        <span className="inspector-media-field-label">{title}</span>
        <div className="inspector-insight-header-actions">
          {canCopy && (
            <button
              type="button"
              className={`inspector-prompt-copy${copyState === 'copied' ? ' copied' : ''}`}
              aria-label={copyState === 'copied'
                ? `${title} copied`
                : `Copy ${title}`}
              title={copyState === 'copied'
                ? `${title} copied`
                : `Copy ${title}`}
              onClick={() => void copy()}
            >
              {copyState === 'copied'
                ? <Check size={12} aria-hidden="true" />
                : <Copy size={12} aria-hidden="true" />}
              <span aria-live="polite">{copyLabel(copyState)}</span>
            </button>
          )}
          {showSrt && (
            <button
              type="button"
              className="inspector-prompt-copy"
              aria-label={canDownload
                ? 'Download SRT'
                : 'Download SRT unavailable'}
              title={canDownload
                ? 'Download SRT'
                : 'No word-timed ElevenLabs transcript'}
              disabled={!canDownload || busy || !onDownloadTranscriptSrt}
              onClick={() => onDownloadTranscriptSrt?.()}
            >
              <Download size={12} aria-hidden="true" />
              <span>SRT</span>
            </button>
          )}
          {transcribe && hasText && (
            <InsightRerunButton
              label="Transcribe again"
              running={Boolean(transcribing)}
              disabled={busy || Boolean(transcribing)}
              onClick={transcribe}
            />
          )}
        </div>
      </header>
      <div
        className="inspector-transcript-tabs"
        role="tablist"
        aria-label={`${title} view`}
      >
        <button
          type="button"
          role="tab"
          aria-selected={view === 'text'}
          className={view === 'text'
            ? 'inspector-transcript-tab active'
            : 'inspector-transcript-tab'}
          onClick={() => selectView('text')}
        >
          TEXT
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'json'}
          aria-disabled={!jsonEnabled}
          disabled={!jsonEnabled}
          title={jsonEnabled
            ? 'JSON'
            : source === 'plain'
              ? 'No GPT-4o translation'
              : 'No ElevenLabs transcript'}
          className={view === 'json'
            ? 'inspector-transcript-tab active'
            : 'inspector-transcript-tab'}
          onClick={() => selectView('json')}
        >
          JSON
        </button>
      </div>
      {meta && <p className="inspector-insight-meta">{meta}</p>}
      {body && !emptyMessage
        ? <TranscriptText text={body} label={`${title} ${view}`} />
        : (
          <div className="inspector-insight-empty">
            <p>{emptyMessage ?? 'No transcript yet.'}</p>
            {transcribe && !hasText && (
              <InsightStartButton
                icon={<Captions size={13} aria-hidden="true" />}
                label={transcript ? 'Transcribe again' : 'Transcribe'}
                runningLabel="Transcribing…"
                running={Boolean(transcribing)}
                disabled={busy || Boolean(transcribing)}
                onClick={transcribe}
              />
            )}
          </div>
        )}
    </section>
  )
}

export function MediaInsightsPanel({
  artifactId,
  transcript,
  busy,
  transcribing,
  error,
  onTranscribe,
  onLoadTranscriptJson,
  onDownloadTranscriptSrt,
}: MediaInsightsPanelProps) {
  return (
    <div className="inspector-media-insights">
      <TranscriptSourceCard
        key={`${artifactId}:plain`}
        source="plain"
        title={PLAIN_TRANSCRIPT_CARD_TITLE}
        transcript={transcript?.plain ?? null}
        busy={busy}
        onLoadTranscriptJson={onLoadTranscriptJson}
      />
      <TranscriptSourceCard
        key={`${artifactId}:elevenlabs`}
        source="elevenlabs"
        title={ELEVENLABS_TRANSCRIPT_CARD_TITLE}
        transcript={transcript?.elevenlabs ?? null}
        busy={busy}
        transcribing={transcribing}
        onTranscribe={onTranscribe}
        onLoadTranscriptJson={onLoadTranscriptJson}
        onDownloadTranscriptSrt={onDownloadTranscriptSrt}
      />
      {error && (
        <p className="inspector-insight-error" role="alert">
          <CircleAlert size={12} aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
    </div>
  )
}

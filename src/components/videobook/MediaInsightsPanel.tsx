import { useState, type ReactNode } from 'react'
import {
  Captions,
  Check,
  CircleAlert,
  Copy,
  Download,
  RefreshCw,
  ScanEye,
} from 'lucide-react'
import {
  canDownloadTranscriptSrt,
  resolveTranscriptTab,
  sourcesAreSilenceOnly,
  sourcesHaveTranscriptText,
  transcriptTabBody,
  transcriptTabCopyText,
  transcriptTabMeta,
  transcriptTabStates,
  visionAnalysisDetailLabel,
  type MediaTranscriptSources,
  type MediaVisionAnalysis,
  type TranscriptTabId,
} from '@/videobook/media-insights'

type CopyState = 'idle' | 'copied' | 'failed'

export type MediaInsightsPanelProps = {
  artifactId: string
  transcript: MediaTranscriptSources | null
  analysis: MediaVisionAnalysis | null
  analyzable: boolean
  busy: boolean
  transcribing: boolean
  analyzing: boolean
  error: string | null
  onTranscribe: () => void
  onAnalyze: () => void
  onLoadTranscriptJson?: () => Promise<{ text: string; file: string }>
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

function TranscriptSection({
  transcript,
  busy,
  transcribing,
  onTranscribe,
  onLoadTranscriptJson,
  onDownloadTranscriptSrt,
}: Pick<
  MediaInsightsPanelProps,
  | 'transcript'
  | 'busy'
  | 'transcribing'
  | 'onTranscribe'
  | 'onLoadTranscriptJson'
  | 'onDownloadTranscriptSrt'
>) {
  const tabs = transcriptTabStates(transcript)
  const [requestedTab, setRequestedTab] = useState<TranscriptTabId | null>(null)
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const [jsonText, setJsonText] = useState<string | null>(null)
  const [jsonFile, setJsonFile] = useState<string | null>(null)
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [jsonLoading, setJsonLoading] = useState(false)
  const activeTab = resolveTranscriptTab(transcript, requestedTab)
  const hasText = sourcesHaveTranscriptText(transcript)
  const silenceOnly = sourcesAreSilenceOnly(transcript)
  const canDownload = canDownloadTranscriptSrt(transcript)
  const body = transcriptTabBody({
    tab: activeTab,
    sources: transcript,
    jsonText,
  })
  const meta = transcriptTabMeta(activeTab, transcript, jsonFile)
  const activeState = tabs.find((tab) => tab.id === activeTab)

  const copy = async () => {
    const text = transcriptTabCopyText({
      tab: activeTab,
      sources: transcript,
      jsonText,
    })
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  const selectTab = (id: TranscriptTabId) => {
    const tab = tabs.find((candidate) => candidate.id === id)
    if (!tab?.enabled) return
    setRequestedTab(id)
    if (id !== 'json' || jsonText !== null || jsonLoading || !onLoadTranscriptJson) {
      return
    }
    setJsonLoading(true)
    setJsonError(null)
    void onLoadTranscriptJson()
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

  const emptyMessage = silenceOnly
    ? 'This clip has a transcript but no spoken dialog.'
    : !transcript
      ? 'No transcript yet.'
      : activeState && !activeState.enabled
        ? activeState.disabledReason
        : activeTab === 'json' && jsonLoading
          ? 'Loading sidecar…'
          : activeTab === 'json' && jsonError
            ? jsonError
            : !body
              ? 'No transcript yet.'
              : null

  return (
    <section className="inspector-insight-block" aria-label="Transcript">
      <header className="inspector-insight-header">
        <span className="inspector-media-field-label">Transcript</span>
        <div className="inspector-insight-header-actions">
          {hasText && (
            <button
              type="button"
              className={`inspector-prompt-copy${copyState === 'copied' ? ' copied' : ''}`}
              aria-label={copyState === 'copied'
                ? 'Transcript copied'
                : 'Copy transcript'}
              title={copyState === 'copied'
                ? 'Transcript copied'
                : 'Copy transcript'}
              onClick={() => void copy()}
            >
              {copyState === 'copied'
                ? <Check size={12} aria-hidden="true" />
                : <Copy size={12} aria-hidden="true" />}
              <span aria-live="polite">{copyLabel(copyState)}</span>
            </button>
          )}
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
          {hasText && (
            <InsightRerunButton
              label="Transcribe again"
              running={transcribing}
              disabled={busy || transcribing}
              onClick={onTranscribe}
            />
          )}
        </div>
      </header>
      <div
        className="inspector-transcript-tabs"
        role="tablist"
        aria-label="Transcript source"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-disabled={!tab.enabled}
            disabled={!tab.enabled}
            title={tab.disabledReason ?? tab.label}
            className={activeTab === tab.id
              ? 'inspector-transcript-tab active'
              : 'inspector-transcript-tab'}
            onClick={() => selectTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {meta && <p className="inspector-insight-meta">{meta}</p>}
      {body && !emptyMessage
        ? <TranscriptText text={body} label={`${activeState?.label ?? 'Transcript'} transcript`} />
        : (
          <div className="inspector-insight-empty">
            <p>{emptyMessage ?? 'No transcript yet.'}</p>
            {!hasText && (
              <InsightStartButton
                icon={<Captions size={13} aria-hidden="true" />}
                label={transcript ? 'Transcribe again' : 'Transcribe'}
                runningLabel="Transcribing…"
                running={transcribing}
                disabled={busy || transcribing}
                onClick={onTranscribe}
              />
            )}
          </div>
        )}
    </section>
  )
}

function AnalysisSection({
  analysis,
  busy,
  analyzing,
  onAnalyze,
}: Pick<
  MediaInsightsPanelProps,
  'analysis' | 'busy' | 'analyzing' | 'onAnalyze'
>) {
  const detail = analysis ? visionAnalysisDetailLabel(analysis) : null

  return (
    <section className="inspector-insight-block" aria-label="Video analysis">
      <header className="inspector-insight-header">
        <span className="inspector-media-field-label">Analysis</span>
        {analysis && (
          <div className="inspector-insight-header-actions">
            <InsightRerunButton
              label="Analyze again"
              running={analyzing}
              disabled={busy || analyzing}
              onClick={onAnalyze}
            />
          </div>
        )}
      </header>
      {analysis
        ? (
          <>
            {detail && <p className="inspector-insight-meta">{detail}</p>}
            {analysis.summary && (
              <p className="inspector-insight-summary">{analysis.summary}</p>
            )}
            {analysis.tags.length > 0 && (
              <ul className="inspector-insight-tags">
                {analysis.tags.map((tag) => <li key={tag}>{tag}</li>)}
              </ul>
            )}
          </>
        )
        : (
          <div className="inspector-insight-empty">
            <p>No vision analysis yet.</p>
            <InsightStartButton
              icon={<ScanEye size={13} aria-hidden="true" />}
              label="Analyze"
              runningLabel="Analyzing…"
              running={analyzing}
              disabled={busy || analyzing}
              onClick={onAnalyze}
            />
          </div>
        )}
    </section>
  )
}

export function MediaInsightsPanel({
  artifactId,
  transcript,
  analysis,
  analyzable,
  busy,
  transcribing,
  analyzing,
  error,
  onTranscribe,
  onAnalyze,
  onLoadTranscriptJson,
  onDownloadTranscriptSrt,
}: MediaInsightsPanelProps) {
  return (
    <div className="inspector-media-insights">
      <TranscriptSection
        key={artifactId}
        transcript={transcript}
        busy={busy}
        transcribing={transcribing}
        onTranscribe={onTranscribe}
        onLoadTranscriptJson={onLoadTranscriptJson}
        onDownloadTranscriptSrt={onDownloadTranscriptSrt}
      />
      {analyzable && (
        <AnalysisSection
          analysis={analysis}
          busy={busy}
          analyzing={analyzing}
          onAnalyze={onAnalyze}
        />
      )}
      {error && (
        <p className="inspector-insight-error" role="alert">
          <CircleAlert size={12} aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
    </div>
  )
}

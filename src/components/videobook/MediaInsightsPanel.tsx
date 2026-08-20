import { useState, type ReactNode } from 'react'
import {
  Captions,
  Check,
  CircleAlert,
  Copy,
  RefreshCw,
  ScanEye,
} from 'lucide-react'
import {
  transcriptDetailLabel,
  transcriptHasText,
  visionAnalysisDetailLabel,
  type MediaTranscript,
  type MediaVisionAnalysis,
} from '@/videobook/media-insights'

type CopyState = 'idle' | 'copied' | 'failed'

export type MediaInsightsPanelProps = {
  transcript: MediaTranscript | null
  analysis: MediaVisionAnalysis | null
  analyzable: boolean
  busy: boolean
  transcribing: boolean
  analyzing: boolean
  error: string | null
  onTranscribe: () => void
  onAnalyze: () => void
}

function copyLabel(state: CopyState): string {
  if (state === 'copied') return 'Copied'
  return state === 'failed' ? 'Retry' : 'Copy'
}

function TranscriptText({ text }: { text: string }) {
  return (
    <pre
      className="inspector-transcript-text"
      tabIndex={0}
      aria-label="Transcript"
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
}: Pick<
  MediaInsightsPanelProps,
  'transcript' | 'busy' | 'transcribing' | 'onTranscribe'
>) {
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const hasText = transcriptHasText(transcript)
  const copy = async () => {
    if (!transcript) return
    try {
      await navigator.clipboard.writeText(transcript.text)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  return (
    <section className="inspector-insight-block" aria-label="Transcript">
      <header className="inspector-insight-header">
        <span className="inspector-media-field-label">Transcript</span>
        {hasText && (
          <div className="inspector-insight-header-actions">
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
            <InsightRerunButton
              label="Transcribe again"
              running={transcribing}
              disabled={busy || transcribing}
              onClick={onTranscribe}
            />
          </div>
        )}
      </header>
      {hasText && transcript
        ? (
          <>
            <p className="inspector-insight-meta">
              {transcriptDetailLabel(transcript)}
            </p>
            <TranscriptText text={transcript.text} />
          </>
        )
        : (
          <div className="inspector-insight-empty">
            <p>
              {transcript?.kind === 'silence'
                ? 'This clip has a transcript but no spoken dialog.'
                : 'No transcript yet.'}
            </p>
            <InsightStartButton
              icon={<Captions size={13} aria-hidden="true" />}
              label={transcript ? 'Transcribe again' : 'Transcribe'}
              runningLabel="Transcribing…"
              running={transcribing}
              disabled={busy || transcribing}
              onClick={onTranscribe}
            />
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
  transcript,
  analysis,
  analyzable,
  busy,
  transcribing,
  analyzing,
  error,
  onTranscribe,
  onAnalyze,
}: MediaInsightsPanelProps) {
  return (
    <div className="inspector-media-insights">
      <TranscriptSection
        transcript={transcript}
        busy={busy}
        transcribing={transcribing}
        onTranscribe={onTranscribe}
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

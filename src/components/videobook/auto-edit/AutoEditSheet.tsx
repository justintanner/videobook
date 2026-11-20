import { useCallback, useRef, useState } from 'react'
import { frameToSeconds } from '../../../../server/src/auto-edit/plan'
import type { AutoEditAnchors } from '../../../../server/src/auto-edit/style'
import {
  autoEditNudgeSeconds,
  autoEditPlanDurationSeconds,
  autoEditSnapSeconds,
  buildAutoEditSegmentRanges,
} from '@/videobook/auto-edit-preview'
import type { AutoEditEditor } from '@/videobook/useAutoEdit'
import { ConfirmSheet } from '../confirm/ConfirmSheet'
import { AutoEditMoment, type AnchorFieldKey } from './AutoEditMoment'
import { AutoEditPreview, type AutoEditSeekCommand } from './AutoEditPreview'
import { AutoEditStrip } from './AutoEditStrip'
import './AutoEditSheet.css'

function updateAnchorTime(
  anchors: AutoEditAnchors,
  key: AnchorFieldKey,
  nextSeconds: number,
  duration: number,
): AutoEditAnchors {
  if (key === 'hook.start') {
    const end = anchors.hook?.end ?? Math.min(duration, nextSeconds + 2.5)
    return { ...anchors, hook: { start: nextSeconds, end } }
  }
  if (key === 'hook.end') {
    const start = anchors.hook?.start ?? Math.max(0, nextSeconds - 2.5)
    return { ...anchors, hook: { start, end: nextSeconds } }
  }
  if (key === 'moment.start') return { ...anchors, moment: { ...anchors.moment, start: nextSeconds } }
  if (key === 'moment.peak') return { ...anchors, moment: { ...anchors.moment, peak: nextSeconds } }
  return { ...anchors, moment: { ...anchors.moment, end: nextSeconds } }
}

function currentAnchorTime(anchors: AutoEditAnchors, key: AnchorFieldKey): number {
  if (key === 'hook.start') return anchors.hook?.start ?? anchors.keep.start
  if (key === 'hook.end') return anchors.hook?.end ?? Math.min(anchors.keep.end, anchors.keep.start + 2.5)
  if (key === 'moment.start') return anchors.moment.start
  if (key === 'moment.peak') return anchors.moment.peak
  return anchors.moment.end
}

export function AutoEditBody({ editor }: { editor: AutoEditEditor }) {
  const { state } = editor
  const readSourceTimeRef = useRef<() => number>(() => 0)
  const [activeSegmentIndex, setActiveSegmentIndex] = useState(0)
  const [seekCommand, setSeekCommand] = useState<AutoEditSeekCommand | null>(null)
  const seekNonceRef = useRef(0)

  const issueSeek = useCallback((command: Omit<AutoEditSeekCommand, 'nonce'>) => {
    seekNonceRef.current += 1
    setSeekCommand({ ...command, nonce: seekNonceRef.current })
  }, [])

  if (!state.source || !state.anchors || !state.plan || !state.target) {
    return (
      <div className="auto-edit-body">
        <p className="auto-edit-muted">{state.loading ? 'Loading auto-edit draft…' : state.error ?? 'Select a video to auto-edit.'}</p>
      </div>
    )
  }

  const ranges = buildAutoEditSegmentRanges(state.plan)
  const totalDurationSeconds = autoEditPlanDurationSeconds(state.plan)
  const safeSegmentIndex = Math.max(0, Math.min(ranges.length - 1, activeSegmentIndex))
  const focusPoint = state.anchors.focus[state.focusAnchor]

  const handleSetToPlayhead = (key: AnchorFieldKey) => {
    const rawTime = readSourceTimeRef.current()
    const snapped = autoEditSnapSeconds(rawTime, state.source!.fps, state.source!.duration)
    editor.setAnchors((anchors) => updateAnchorTime(anchors, key, snapped, state.source!.duration))
    issueSeek({ kind: 'source', sourceSeconds: snapped, play: false })
  }

  const handleNudgeAnchor = (key: AnchorFieldKey, deltaFrames: number) => {
    let nextTime = frameToSeconds(0, state.source!.fps)
    editor.setAnchors((anchors, fps, duration) => {
      nextTime = autoEditNudgeSeconds(currentAnchorTime(anchors, key), deltaFrames, fps, duration)
      return updateAnchorTime(anchors, key, nextTime, duration)
    })
    issueSeek({ kind: 'source', sourceSeconds: nextTime, play: false })
  }

  const handleSelectFocusAnchor = (which: 'start' | 'peak' | 'end') => {
    editor.setFocusAnchor(which)
    const time = state.anchors!.moment[which]
    issueSeek({ kind: 'source', sourceSeconds: time, play: false })
  }

  const handleConfirmAnalysis = (force: boolean) => {
    void editor.confirmAnalysis(force)
  }

  return (
    <div className="auto-edit-body">
      <AutoEditStrip
        ranges={ranges}
        activeIndex={safeSegmentIndex}
        totalDurationSeconds={totalDurationSeconds}
        onSelectSegment={(index) => {
          setActiveSegmentIndex(index)
          issueSeek({ kind: 'segment', segmentIndex: index, play: true })
        }}
      />
      <div className="auto-edit-layout">
        <AutoEditPreview
          key={state.target.artifactId}
          plan={state.plan}
          cues={state.cues}
          mediaUrl={state.target.mediaUrl}
          soundsEnabled={state.sections.sounds}
          focusPoint={focusPoint}
          seekCommand={seekCommand}
          readSourceTimeRef={readSourceTimeRef}
          activeSegmentIndex={safeSegmentIndex}
          onActiveSegmentChange={setActiveSegmentIndex}
          onPlaceFocus={(point) => editor.setFocusPoint(state.focusAnchor, point)}
        />
        <AutoEditMoment
          source={state.source}
          anchors={state.anchors}
          sections={state.sections}
          changes={state.changes}
          focusAnchor={state.focusAnchor}
          analysisAvailable={state.analysisAvailable}
          analysisPhase={state.analysisPhase}
          disabled={state.rendering}
          onSectionChange={editor.setSection}
          onSetToPlayhead={handleSetToPlayhead}
          onNudgeAnchor={handleNudgeAnchor}
          onSelectFocusAnchor={handleSelectFocusAnchor}
          onRequestEstimate={(force) => void editor.requestAnalysisEstimate(force)}
          onConfirmAnalysis={handleConfirmAnalysis}
          onDismissEstimate={editor.dismissAnalysisEstimate}
        />
      </div>
    </div>
  )
}

export function AutoEditSheet({
  editor,
  applyFormId,
  onClose,
}: {
  editor: AutoEditEditor
  applyFormId: string
  onClose: () => void
}) {
  const { state } = editor
  const blocking = state.loading
    ? 'Loading auto-edit draft…'
    : state.error
      ? state.error
      : !state.plan
        ? 'No auto-edit plan available.'
        : null
  return (
    <ConfirmSheet
      kind="auto-edit"
      ariaLabel="Auto-edit review"
      tag="AUTO EDIT"
      title={`Auto-edit · ${state.target?.label ?? 'video'}`}
      address={state.target?.address ? `@${state.target.address}` : null}
      applyLabel="Render"
      cancelLabel="Cancel"
      busy={state.rendering}
      busyLabel="Rendering auto-edit…"
      effect={{ label: 'New cell · versions on repeat', tone: 'default' }}
      validation={{ blocking, notice: state.changes[0] ?? null }}
      applyFormId={applyFormId}
      onCancel={onClose}
    >
      <AutoEditBody editor={editor} />
    </ConfirmSheet>
  )
}

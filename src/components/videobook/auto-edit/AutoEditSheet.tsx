import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { secondsToFrame, type SegmentPlan } from '../../../../server/src/auto-edit/plan'
import { CRASH_REPLAY, type AutoEditAnchors, type AutoEditSections } from '../../../../server/src/auto-edit/style'
import {
  autoEditNudgeSeconds,
  autoEditPlanDurationSeconds,
  autoEditSnapSeconds,
  buildAutoEditSegmentRanges,
} from '@/videobook/auto-edit-preview'
import {
  AUTO_EDIT_ANCHOR_INFO,
  autoEditAnchorSeconds,
  autoEditBeats,
  autoEditEditPercentAt,
  autoEditItemsForAnchor,
  autoEditLaneItemAt,
  autoEditSourcePercent,
  autoEditWithAnchor,
  buildAutoEditLaneItems,
  buildAutoEditTimelineLayout,
  type AutoEditAnchorKey,
} from '@/videobook/auto-edit-review'
import type { AutoEditEditor, AutoEditSource, AutoEditTarget } from '@/videobook/useAutoEdit'
import { ConfirmSheet } from '../confirm/ConfirmSheet'
import { AutoEditAnalysis } from './AutoEditAnalysis'
import { AutoEditBeats } from './AutoEditBeats'
import { AutoEditInspector } from './AutoEditInspector'
import {
  AutoEditPreview,
  type AutoEditPreviewMode,
  type AutoEditPreviewPosition,
  type AutoEditSeekCommand,
} from './AutoEditPreview'
import { AutoEditTimeline, type AutoEditSelection } from './AutoEditTimeline'
import './AutoEditSheet.css'

interface AutoEditReviewProps {
  editor: AutoEditEditor
  source: AutoEditSource
  anchors: AutoEditAnchors
  plan: SegmentPlan
  target: AutoEditTarget
}

function useLaneWidth(laneRef: RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const lane = laneRef.current
    if (!lane) return
    const observer = new ResizeObserver((entries) => {
      setWidth(Math.round(entries[0]?.contentRect.width ?? 0))
    })
    observer.observe(lane)
    return () => observer.disconnect()
  }, [laneRef])
  return width
}

function AutoEditReview({ editor, source, anchors, plan, target }: AutoEditReviewProps) {
  const { state } = editor
  const readSourceTimeRef = useRef<() => number>(() => 0)
  const editLaneRef = useRef<HTMLDivElement>(null)
  const editPlayheadRef = useRef<HTMLSpanElement>(null)
  const sourcePlayheadRef = useRef<HTMLSpanElement>(null)
  const seekNonceRef = useRef(0)
  const [activeSegmentIndex, setActiveSegmentIndex] = useState(0)
  const [selection, setSelection] = useState<AutoEditSelection>({ kind: 'segment', index: 0 })
  const [mode, setMode] = useState<AutoEditPreviewMode>('plan')
  const [seekCommand, setSeekCommand] = useState<AutoEditSeekCommand | null>(null)

  const ranges = useMemo(() => buildAutoEditSegmentRanges(plan), [plan])
  const items = useMemo(() => buildAutoEditLaneItems(ranges), [ranges])
  const laneWidth = useLaneWidth(editLaneRef)
  const blocks = useMemo(() => buildAutoEditTimelineLayout(items, laneWidth), [items, laneWidth])
  const totalSeconds = autoEditPlanDurationSeconds(plan)
  const fps = source.fps
  const duration = source.duration
  const safeSegmentIndex = Math.max(0, Math.min(ranges.length - 1, activeSegmentIndex))
  const disabled = state.rendering

  const issueSeek = useCallback((command: Omit<AutoEditSeekCommand, 'nonce'>) => {
    seekNonceRef.current += 1
    setSeekCommand({ ...command, nonce: seekNonceRef.current })
  }, [])

  const handlePosition = useCallback((position: AutoEditPreviewPosition) => {
    const edit = editPlayheadRef.current
    if (edit) {
      edit.hidden = position.outputSeconds === null
      if (position.outputSeconds !== null) {
        edit.style.left = `${autoEditEditPercentAt(items, blocks, position.outputSeconds).toFixed(3)}%`
      }
    }
    const sourceHead = sourcePlayheadRef.current
    if (sourceHead) sourceHead.style.left = `${autoEditSourcePercent(position.sourceSeconds, duration).toFixed(3)}%`
  }, [blocks, duration, items])

  const showSourceAt = (seconds: number) => {
    setMode('source')
    issueSeek({ kind: 'source', sourceSeconds: seconds, play: false })
  }

  const selectSegment = (index: number) => {
    setSelection({ kind: 'segment', index })
    setActiveSegmentIndex(index)
    setMode('plan')
    issueSeek({ kind: 'segment', segmentIndex: index, play: true })
  }

  const markSelectedAnchor = (key: AutoEditAnchorKey) => {
    setSelection({ kind: 'anchor', key })
    const focus = AUTO_EDIT_ANCHOR_INFO[key].focus
    if (focus) editor.setFocusAnchor(focus)
  }

  const selectAnchor = (key: AutoEditAnchorKey) => {
    markSelectedAnchor(key)
    showSourceAt(autoEditAnchorSeconds(anchors, key))
  }

  const dragAnchor = (key: AutoEditAnchorKey, seconds: number) => {
    const snapped = autoEditSnapSeconds(seconds, fps, duration)
    if (selection.kind !== 'anchor' || selection.key !== key) markSelectedAnchor(key)
    if (secondsToFrame(autoEditAnchorSeconds(anchors, key), fps) === secondsToFrame(snapped, fps)) return
    editor.setAnchors((current) => autoEditWithAnchor(current, key, snapped, duration))
    showSourceAt(snapped)
  }

  const removeCut = (cutIndex: number) => {
    editor.setAnchors((current) => ({ ...current, cuts: current.cuts.filter((_, index) => index !== cutIndex) }))
  }

  const nudgeAnchor = (key: AutoEditAnchorKey, deltaFrames: number) => {
    setSelection({ kind: 'anchor', key })
    let nextTime = autoEditAnchorSeconds(anchors, key)
    editor.setAnchors((current, currentFps, currentDuration) => {
      nextTime = autoEditNudgeSeconds(autoEditAnchorSeconds(current, key), deltaFrames, currentFps, currentDuration)
      return autoEditWithAnchor(current, key, nextTime, currentDuration)
    })
    showSourceAt(nextTime)
  }

  const setAnchorToPlayhead = (key: AutoEditAnchorKey) => {
    const snapped = autoEditSnapSeconds(readSourceTimeRef.current(), fps, duration)
    editor.setAnchors((current) => autoEditWithAnchor(current, key, snapped, duration))
    showSourceAt(snapped)
  }

  const changeMode = (next: AutoEditPreviewMode) => {
    setMode(next)
    issueSeek({ kind: next === 'plan' ? 'resume-plan' : 'source-current' })
  }

  const changeSection = (key: keyof AutoEditSections, enabled: boolean) => {
    editor.setSection(key, enabled)
    if (selection.kind === 'segment') setSelection({ kind: 'segment', index: 0 })
  }

  const linkedItemIndexes = new Set(
    selection.kind === 'anchor'
      ? autoEditItemsForAnchor(items, anchors, selection.key, fps).map((item) => item.index)
      : [],
  )
  const activeItemIndex = mode === 'plan'
    ? autoEditLaneItemAt(items, safeSegmentIndex)?.index ?? null
    : selection.kind === 'segment' ? selection.index : null
  const bodyStyle = { '--auto-edit-aspect': `${source.width / source.height}` } as CSSProperties

  return (
    <div className="auto-edit-body" style={bodyStyle}>
      <AutoEditPreview
        key={target.artifactId}
        plan={plan}
        cues={state.cues}
        mediaUrl={target.mediaUrl}
        soundsEnabled={state.sections.sounds}
        focusPoint={anchors.focus[state.focusAnchor]}
        focusLabel={state.focusAnchor}
        mode={mode}
        seekCommand={seekCommand}
        readSourceTimeRef={readSourceTimeRef}
        activeSegmentIndex={safeSegmentIndex}
        onActiveSegmentChange={setActiveSegmentIndex}
        onModeChange={changeMode}
        onPlaceFocus={(point) => editor.setFocusPoint(state.focusAnchor, point)}
        onPosition={handlePosition}
      />
      <div className="auto-edit-side">
        <AutoEditAnalysis
          address={target.address ? `@${target.address}` : 'this clip'}
          analysisAvailable={state.analysisAvailable}
          analysisPhase={state.analysisPhase}
          disabled={disabled}
          onRequestEstimate={(force) => void editor.requestAnalysisEstimate(force)}
          onConfirmAnalysis={(force) => void editor.confirmAnalysis(force)}
          onDismissEstimate={editor.dismissAnalysisEstimate}
        />
        <AutoEditTimeline
          items={items}
          blocks={blocks}
          cues={state.sections.sounds ? state.cues : []}
          anchors={anchors}
          sections={state.sections}
          durationSeconds={duration}
          totalSeconds={totalSeconds}
          mediaUrl={target.mediaUrl}
          portrait={source.height > source.width}
          selection={selection}
          activeItemIndex={activeItemIndex}
          linkedItemIndexes={linkedItemIndexes}
          disabled={disabled}
          editLaneRef={editLaneRef}
          editPlayheadRef={editPlayheadRef}
          sourcePlayheadRef={sourcePlayheadRef}
          onSelectSegment={selectSegment}
          onSelectAnchor={selectAnchor}
          onNudgeAnchor={nudgeAnchor}
          onDragAnchor={dragAnchor}
          onSeekSource={showSourceAt}
        />
        <div className="auto-edit-panels">
          <AutoEditBeats
            beats={autoEditBeats(anchors, state.sections, state.cues)}
            sections={state.sections}
            disabled={disabled}
            onSectionChange={changeSection}
          />
          <AutoEditInspector
            selection={selection}
            anchors={anchors}
            items={items}
            fps={fps}
            changes={state.changes}
            disabled={disabled}
            onNudgeAnchor={nudgeAnchor}
            onSetToPlayhead={setAnchorToPlayhead}
            onSelectAnchor={selectAnchor}
            onRemoveCut={removeCut}
          />
        </div>
      </div>
    </div>
  )
}

export function AutoEditBody({ editor }: { editor: AutoEditEditor }) {
  const { state } = editor
  if (!state.source || !state.anchors || !state.plan || !state.target) {
    return (
      <div className="auto-edit-body auto-edit-body-empty">
        <p className="auto-edit-muted">{state.loading ? 'Loading auto-edit draft…' : state.error ?? 'Select a video to auto-edit.'}</p>
      </div>
    )
  }
  return <AutoEditReview editor={editor} source={state.source} anchors={state.anchors} plan={state.plan} target={state.target} />
}

function sourceSummary(source: AutoEditSource, plan: SegmentPlan | null): string {
  const rate = Number(source.fps.toFixed(2))
  const edit = plan ? ` → ${autoEditPlanDurationSeconds(plan).toFixed(2)}s edit` : ''
  return `${source.width}×${source.height} · ${source.duration.toFixed(2)}s · ${rate} fps${edit}`
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
      title={`Auto-edit · ${CRASH_REPLAY.name}`}
      address={state.target?.address ? `@${state.target.address}` : null}
      applyLabel="Render"
      cancelLabel="Cancel"
      busy={state.rendering}
      busyLabel="Rendering auto-edit…"
      effect={{ label: 'Renders to a new cell', tone: 'default' }}
      headerActions={state.source ? <span className="auto-edit-summary">{sourceSummary(state.source, state.plan)}</span> : null}
      validation={{ blocking, notice: state.changes[0] ?? null }}
      applyFormId={applyFormId}
      onCancel={onClose}
    >
      <AutoEditBody editor={editor} />
    </ConfirmSheet>
  )
}

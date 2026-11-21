import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import type { SegmentPlan } from '../../../../server/src/auto-edit/plan'
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
  autoEditTrimClip,
  autoEditTrimEdges,
  autoEditSourcePercent,
  autoEditWithAnchor,
  buildAutoEditLaneItems,
  buildAutoEditTimelineLayout,
  type AutoEditAnchorKey,
  type AutoEditTrimEdge,
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
import { AutoEditTimeline } from './AutoEditTimeline'
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
  const [selectedClip, setSelectedClip] = useState<string | null>(null)
  const [selectedMarker, setSelectedMarker] = useState<AutoEditAnchorKey | null>(null)
  const [mode, setMode] = useState<AutoEditPreviewMode>('plan')
  const [seekCommand, setSeekCommand] = useState<AutoEditSeekCommand | null>(null)

  const ranges = useMemo(() => buildAutoEditSegmentRanges(plan), [plan])
  const items = useMemo(() => buildAutoEditLaneItems(ranges, anchors), [ranges, anchors])
  const item = items.find((entry) => entry.key === selectedClip) ?? items[0]
  const edges = item ? autoEditTrimEdges(item, items, anchors, source) : []
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
    issueSeek({ kind: 'source', sourceSeconds: seconds })
  }

  const selectSegment = (index: number) => {
    const next = items.find((entry) => entry.index === index)
    if (!next) return
    setSelectedClip(next.key)
    setSelectedMarker(null)
    setActiveSegmentIndex(index)
    setMode('plan')
    issueSeek({ kind: 'segment' })
  }

  const focusAnchor = (key: AutoEditAnchorKey) => {
    const focus = AUTO_EDIT_ANCHOR_INFO[key].focus
    if (focus && state.focusAnchor !== focus) editor.setFocusAnchor(focus)
  }

  const selectMarker = (key: AutoEditAnchorKey) => {
    setSelectedMarker(key)
    const linked = autoEditItemsForAnchor(items, key)
    if (linked.length && linked.every((entry) => entry.key !== item?.key)) setSelectedClip(linked[0]!.key)
    focusAnchor(key)
  }

  const selectAnchor = (key: AutoEditAnchorKey) => {
    selectMarker(key)
    showSourceAt(autoEditAnchorSeconds(anchors, key))
  }

  const moveAnchor = (key: AutoEditAnchorKey, seconds: number) => {
    const snapped = autoEditSnapSeconds(seconds, fps, duration)
    const applied = editor.setAnchors(() => autoEditWithAnchor(anchors, key, snapped, duration))
    if (applied) showSourceAt(autoEditAnchorSeconds(applied, key))
  }

  const dragAnchor = (key: AutoEditAnchorKey, seconds: number) => {
    selectMarker(key)
    moveAnchor(key, seconds)
  }

  const nudgeAnchor = (key: AutoEditAnchorKey, deltaFrames: number) => {
    dragAnchor(key, autoEditNudgeSeconds(autoEditAnchorSeconds(anchors, key), deltaFrames, fps, duration))
  }

  const trimEdge = (edge: AutoEditTrimEdge, seconds: number) => {
    if (!item) return
    setSelectedMarker(null)
    focusAnchor(edge.key)
    const applied = editor.setAnchors(() => autoEditTrimClip(item, edge, seconds, anchors, source))
    if (applied) showSourceAt(autoEditAnchorSeconds(applied, edge.key))
  }

  const removeCut = (cutIndex: number) => {
    editor.setAnchors((current) => ({ ...current, cuts: current.cuts.filter((_, index) => index !== cutIndex) }))
    if (mode === 'plan') issueSeek({ kind: 'segment' })
  }

  const changeMode = (next: AutoEditPreviewMode) => {
    setMode(next)
    issueSeek({ kind: next === 'plan' ? 'segment' : 'source-current' })
  }

  const changeSection = (key: keyof AutoEditSections, enabled: boolean) => {
    editor.setSection(key, enabled)
    setSelectedMarker(null)
    if (mode === 'plan' && key !== 'sounds') issueSeek({ kind: 'segment' })
  }

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
        selectedSegmentIndex={item?.index ?? 0}
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
          item={item}
          edges={edges}
          fps={fps}
          selectedMarker={selectedMarker}
          disabled={disabled}
          editLaneRef={editLaneRef}
          editPlayheadRef={editPlayheadRef}
          sourcePlayheadRef={sourcePlayheadRef}
          onSelectSegment={selectSegment}
          onSelectAnchor={selectAnchor}
          onNudgeAnchor={nudgeAnchor}
          onDragAnchor={dragAnchor}
          onCloseMarkers={() => setSelectedMarker(null)}
          onTrim={trimEdge}
          onSetEdgeToPlayhead={(edge) => trimEdge(edge, readSourceTimeRef.current())}
          onInspectEdge={(edge) => {
            setSelectedMarker(null)
            focusAnchor(edge.key)
            showSourceAt(edge.seconds)
          }}
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
            item={item}
            selectedMarker={selectedMarker}
            anchors={anchors}
            items={items}
            fps={fps}
            changes={state.changes}
            disabled={disabled}
            onNudgeAnchor={nudgeAnchor}
            onSetToPlayhead={(key) => dragAnchor(key, readSourceTimeRef.current())}
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

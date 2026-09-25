import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Player, type PlayerRef } from '@remotion/player'
import { X } from 'lucide-react'
import type { AliveSettings } from '../../../server/src/remotion/subtitles/alive-types'
import { resolveAliveCues } from '../../../server/src/remotion/subtitles/alive-layout'
import { AliveCaptionsPreview, type AliveCaptionsPreviewProps } from '@/remotion/AliveCaptionsPreview'
import {
  ALIVE_ORIENTATIONS,
  aliveWordRows,
  cueIndexAt,
  defaultAliveOrientation,
  driftRange,
  orientationGeometry,
  placementLabel,
  type AliveOrientation,
  type AliveStudioData,
} from '@/videobook/alive-captions'
import { restoreFocusElement } from '@/videobook/command-composer-focus'
import { AliveSettingsPanel, AliveTranscriptPanel } from './AliveCaptionsPanels'
import { AliveCaptionsTimeline } from './AliveCaptionsTimeline'
import './AliveCaptionsStudio.css'

export type AliveStudioAsset = {
  artifactId: string
  label: string
  mediaUrl: string
  width: number | null
  height: number | null
  fps: number | null
}

export type AliveStudioState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: AliveStudioData }

type AliveCaptionsStudioProps = {
  asset: AliveStudioAsset
  state: AliveStudioState
  returnFocus: HTMLElement | null
  onClose: () => void
  onSave: (settings: AliveSettings) => Promise<void>
  onRender: (settings: AliveSettings, orientation: AliveOrientation) => Promise<void>
  onReanalyze: () => Promise<void>
}

const FALLBACK_FPS = 30

function useModalDialog(returnFocus: HTMLElement | null) {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    dialog?.querySelector<HTMLButtonElement>('.alive-close')?.focus()
    return () => {
      dialog?.close()
      restoreFocusElement(returnFocus)
    }
  }, [returnFocus])
  return dialogRef
}

function usePlayerClock(playerRef: RefObject<PlayerRef | null>) {
  const [frame, setFrame] = useState(0)
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    const player = playerRef.current
    if (!player) return
    const onFrame = (event: { detail: { frame: number } }) => setFrame(event.detail.frame)
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    player.addEventListener('frameupdate', onFrame)
    player.addEventListener('play', onPlay)
    player.addEventListener('pause', onPause)
    return () => {
      player.removeEventListener('frameupdate', onFrame)
      player.removeEventListener('play', onPlay)
      player.removeEventListener('pause', onPause)
    }
  }, [playerRef])
  return { frame, playing }
}

export function AliveCaptionsStudio(props: AliveCaptionsStudioProps) {
  const { asset, state, returnFocus, onClose } = props
  const dialogRef = useModalDialog(returnFocus)
  return (
    <dialog
      className="alive-studio"
      aria-label={`Alive captions for ${asset.label}`}
      onCancel={(event) => { event.preventDefault(); onClose() }}
      ref={dialogRef}
    >
      {state.status === 'ready'
        ? <StudioBody {...props} data={state.data} />
        : (
          <div className="alive-studio-message">
            <StudioHeader label={asset.label} detail={null} onClose={onClose} />
            <p role={state.status === 'error' ? 'alert' : 'status'}>
              {state.status === 'error' ? state.message : 'Analysing vocals, phrases and faces…'}
            </p>
          </div>
        )}
    </dialog>
  )
}

function StudioHeader({ label, detail, onClose, children }: {
  label: string
  detail: string | null
  onClose: () => void
  children?: ReactNode
}) {
  return (
    <header className="alive-header">
      <h2>Alive captions</h2>
      <span className="alive-muted">{label}{detail ? ` · ${detail}` : ''}</span>
      <span className="alive-spacer" />
      {children}
      <button type="button" className="alive-close" aria-label="Close alive captions" onClick={onClose}><X size={16} /></button>
    </header>
  )
}

function StudioBody({ asset, data, onClose, onSave, onRender, onReanalyze }: AliveCaptionsStudioProps & { data: AliveStudioData }) {
  const { analysis } = data
  const fps = Math.round(asset.fps ?? FALLBACK_FPS) || FALLBACK_FPS
  const durationInFrames = Math.max(1, Math.round(analysis.durationSeconds * fps))
  const [settings, setSettings] = useState<AliveSettings>(data.settings)
  const [orientation, setOrientation] = useState<AliveOrientation>(() => defaultAliveOrientation(asset.width, asset.height))
  const [showRegions, setShowRegions] = useState(true)
  const [working, setWorking] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const playerRef = useRef<PlayerRef | null>(null)
  const { frame, playing } = usePlayerClock(playerRef)
  const time = frame / fps

  const geometry = useMemo(() => orientationGeometry(analysis, orientation), [analysis, orientation])
  const cues = useMemo(() => resolveAliveCues(analysis.phrases, settings, geometry), [analysis.phrases, settings, geometry])
  const rows = useMemo(() => aliveWordRows(analysis, settings), [analysis, settings])
  const drift = useMemo(() => driftRange(rows), [rows])
  const inputProps = useMemo<AliveCaptionsPreviewProps>(() => ({
    mediaUrl: asset.mediaUrl,
    sourceWidth: analysis.sourceWidth,
    sourceHeight: analysis.sourceHeight,
    cues,
    phrases: analysis.phrases,
    settings,
    showRegions,
  }), [asset.mediaUrl, analysis, cues, settings, showRegions])

  const activeCue = cueIndexAt(cues, time)
  const seek = (seconds: number) => playerRef.current?.seekTo(Math.max(0, Math.min(durationInFrames - 1, Math.round(seconds * fps))))
  const patch = (next: Partial<AliveSettings>) => setSettings((current) => ({ ...current, ...next }))
  const run = async (label: string, action: () => Promise<void>, done: string) => {
    setWorking(label)
    setNotice(null)
    try {
      await action()
      setNotice(done)
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setWorking(null)
    }
  }
  const target = ALIVE_ORIENTATIONS.find((option) => option.id === orientation) ?? ALIVE_ORIENTATIONS[0]

  return (
    <div className="alive-studio-body">
      <StudioHeader label={asset.label} detail={`${analysis.sourceWidth}×${analysis.sourceHeight} · ${fps} fps`} onClose={onClose}>
        <div className="alive-segmented" role="group" aria-label="Preview orientation">
          {ALIVE_ORIENTATIONS.map((option) => (
            <button key={option.id} type="button" aria-pressed={option.id === orientation} onClick={() => setOrientation(option.id)}>{option.label}</button>
          ))}
        </div>
        <button type="button" className="alive-secondary" disabled={working !== null} onClick={() => void run('Saving', () => onSave(settings), 'Saved. Renders of this video now use alive captions.')}>Save</button>
        <button type="button" className="alive-primary" disabled={working !== null} onClick={() => void run('Rendering', () => onRender(settings, orientation), `Saved and queued a ${target.label} render.`)}>
          Render {target.label}
        </button>
      </StudioHeader>
      <div className="alive-main">
        <AliveTranscriptPanel
          rows={rows}
          phraseLabels={cues.map(placementLabel)}
          activePhrase={activeCue}
          time={time}
          snapped={settings.snapToOnsets}
          onSeek={seek}
        />
        <div className="alive-stage">
          <div className="alive-player" style={{ aspectRatio: `${target.width} / ${target.height}` }}>
            <Player
              ref={playerRef}
              component={AliveCaptionsPreview}
              inputProps={inputProps}
              durationInFrames={durationInFrames}
              fps={fps}
              compositionWidth={target.width}
              compositionHeight={target.height}
              style={{ width: '100%', height: '100%' }}
              clickToPlay
              spaceKeyToPlayOrPause
            />
          </div>
          <p className="alive-status" role="status">
            {working ? `${working}…` : notice ?? (activeCue >= 0 ? `${placementLabel(cues[activeCue])} · ${cues[activeCue].lines.length} lines` : 'Between phrases')}
          </p>
        </div>
        <AliveSettingsPanel
          settings={settings}
          showRegions={showRegions}
          regionsAnalyzed={analysis.regionsAnalyzed}
          working={working !== null}
          onChange={patch}
          onShowRegions={setShowRegions}
          onReanalyze={() => void run('Re-running analysis', onReanalyze, 'Analysis refreshed.')}
        />
      </div>
      <AliveCaptionsTimeline
        duration={analysis.durationSeconds}
        fps={fps}
        time={time}
        playing={playing}
        envelope={analysis.envelope}
        rows={rows}
        cues={cues}
        activeCue={activeCue}
        snapped={settings.snapToOnsets}
        drift={drift}
        onSeek={seek}
        onStep={(frames) => seek(time + frames / fps)}
        onTogglePlay={() => playerRef.current?.toggle()}
        onToggleSnap={() => patch({ snapToOnsets: !settings.snapToOnsets })}
      />
    </div>
  )
}

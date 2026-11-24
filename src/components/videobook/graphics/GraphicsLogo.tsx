import { useState, type ReactNode } from 'react'
import { Ban, ImageIcon, Plus, Star } from 'lucide-react'
import type { GraphicsEdit } from '../../../../server/src/graphics/edits'
import {
  DEFAULT_GRAPHICS_LOGO_OPACITY,
  DEFAULT_GRAPHICS_LOGO_SIZE,
  GRAPHICS_LOGO_CORNERS,
  graphicsLogoCorner,
  graphicsLogoCornerPosition,
  graphicsLogoLayer,
  graphicsLogoOf,
  sameGraphicsLogo,
  type GraphicsLogo as GraphicsLogoValue,
  type GraphicsLogoCorner,
} from '../../../../server/src/graphics/logo'
import type { GraphicsDocument, GraphicsImageLayer } from '../../../../server/src/graphics/model'
import {
  GRAPHICS_ANCHOR_NAMES,
  graphicsLogoChoices,
  graphicsLogoPickEdits,
  graphicsLogoRemoveEdits,
  graphicsPercent,
  type GraphicsImageChoice,
  type GraphicsRead,
} from '@/videobook/graphics-model'
import type { GraphicsTemplateOutcome } from '@/videobook/useGraphicsEditor'
import { Range } from './GraphicsFields'

type Edit = (edits: GraphicsEdit[], coalesceKey?: string | null) => boolean

const CORNER_DOTS: Record<GraphicsLogoCorner, { x: number; y: number }> = {
  'top-left': { x: 2, y: 2 },
  'top-right': { x: 8, y: 2 },
  'bottom-left': { x: 2, y: 16 },
  'bottom-right': { x: 8, y: 16 },
}

function LogoTile({ label, pressed, expanded, disabled, title, onClick, children }: {
  label: string
  pressed?: boolean
  expanded?: boolean
  disabled: boolean
  title?: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className="graphics-logo-tile"
      aria-pressed={pressed}
      aria-expanded={expanded}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="graphics-logo-tile-box" aria-hidden="true">{children}</span>
      <span className="graphics-logo-tile-label">{label}</span>
    </button>
  )
}

function CornerPicker({ corner, disabled, onPick }: { corner: GraphicsLogoCorner | null; disabled: boolean; onPick: (corner: GraphicsLogoCorner) => void }) {
  return (
    <div className="graphics-logo-corners" role="group" aria-label="Logo corner">
      {GRAPHICS_LOGO_CORNERS.map((option) => (
        <button
          key={option}
          type="button"
          aria-label={`Logo in the ${GRAPHICS_ANCHOR_NAMES[option]} corner`}
          title={`Put the logo in the ${GRAPHICS_ANCHOR_NAMES[option]} corner of the safe area`}
          aria-pressed={corner === option}
          disabled={disabled}
          onClick={() => onPick(option)}
        >
          <svg width="14" height="22" viewBox="0 0 14 22" aria-hidden="true">
            <rect x="0.75" y="0.75" width="12.5" height="20.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <rect x={CORNER_DOTS[option].x} y={CORNER_DOTS[option].y} width="4" height="4" rx="1" className="graphics-logo-corner-dot" />
          </svg>
        </button>
      ))}
    </div>
  )
}

function LogoPicker({ choices, current, disabled, onPick, onCancel }: {
  choices: readonly GraphicsImageChoice[]
  current: string | null
  disabled: boolean
  onPick: (artifactId: string) => void
  onCancel: () => void
}) {
  return (
    <div className="graphics-logo-picker" role="group" aria-label="Choose the logo image">
      {choices.map((choice) => (
        <button key={choice.artifactId} type="button" aria-pressed={choice.artifactId === current} disabled={disabled} onClick={() => onPick(choice.artifactId)}>
          {choice.url ? <img src={choice.url} alt="" draggable={false} /> : <ImageIcon size={14} aria-hidden="true" />}
          <span><code>@{choice.address}</code> {choice.label}</span>
        </button>
      ))}
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  )
}

function LogoDefault({ layer, logo, bookName, disabled, onSetDefault }: {
  layer: GraphicsImageLayer | null
  logo: GraphicsLogoValue | null
  bookName: string | null
  disabled: boolean
  onSetDefault: (logo: GraphicsLogoValue | null) => Promise<GraphicsTemplateOutcome>
}) {
  const [pending, setPending] = useState<boolean | null>(null)
  const [notice, setNotice] = useState<GraphicsTemplateOutcome | null>(null)
  const busy = pending !== null
  const current = layer ? graphicsLogoOf(layer) : null
  const differs = Boolean(logo && current && !sameGraphicsLogo(logo, current))
  const run = async (next: GraphicsLogoValue | null) => {
    setPending(next !== null)
    setNotice(null)
    try {
      setNotice(await onSetDefault(next))
    } finally {
      setPending(null)
    }
  }
  return (
    <div className="graphics-logo-default">
      <label className="graphics-switch">
        <input
          type="checkbox"
          role="switch"
          checked={pending ?? logo !== null}
          disabled={disabled || busy || (logo === null && current === null)}
          onChange={(event) => void run(event.target.checked ? current : null)}
        />
        <span>Start new videos in {bookName ?? 'this book'} with this logo</span>
      </label>
      {differs && <button type="button" disabled={disabled || busy} onClick={() => void run(current)}>Update default</button>}
      {notice && <p className="graphics-template-notice" role={notice.ok ? 'status' : 'alert'} data-tone={notice.ok ? 'info' : 'error'}>{notice.message}</p>}
    </div>
  )
}

export function GraphicsLogo({ document, read, imageChoices, bookName, disabled, onEdit, onSetDefault }: {
  document: GraphicsDocument
  read: GraphicsRead
  imageChoices: readonly GraphicsImageChoice[]
  bookName: string | null
  disabled: boolean
  onEdit: Edit
  onSetDefault: (logo: GraphicsLogoValue | null) => Promise<GraphicsTemplateOutcome>
}) {
  const [picking, setPicking] = useState(false)
  const layer = graphicsLogoLayer(document)
  const choices = graphicsLogoChoices(document, read, imageChoices)
  const pick = (artifactId: string) => {
    setPicking(false)
    const edits = graphicsLogoPickEdits(document, artifactId, read.logo)
    if (edits.length > 0) onEdit(edits)
  }
  const remove = () => {
    const edits = graphicsLogoRemoveEdits(document)
    if (edits.length > 0) onEdit(edits)
  }
  const place = (corner: GraphicsLogoCorner) => {
    if (layer) onEdit([{ op: 'set_position', layer_id: layer.id, position: graphicsLogoCornerPosition(corner) }])
  }
  const setSize = (size: number) => {
    if (layer) onEdit([{ op: 'set_image', layer_id: layer.id, image: { size } }], `${layer.id}:size`)
  }
  const setOpacity = (opacity: number) => {
    if (layer) onEdit([{ op: 'set_layer', layer_id: layer.id, layer: { opacity } }], `${layer.id}:opacity`)
  }
  return (
    <section className="graphics-logo" aria-label="Logo">
      <div className="graphics-logo-head">
        <span className="graphics-section-label">Logo</span>
        {read.logo && <span className="graphics-logo-badge"><Star size={10} aria-hidden="true" />Book default</span>}
      </div>
      <div className="graphics-logo-row">
        <div className="graphics-logo-tiles" role="group" aria-label="Logo image">
          <LogoTile label="None" pressed={layer === null} disabled={disabled} title="No logo on this video" onClick={remove}>
            <Ban size={18} />
          </LogoTile>
          {choices.map((choice) => (
            <LogoTile
              key={choice.artifactId}
              label={choice.label}
              pressed={layer?.artifactId === choice.artifactId}
              disabled={disabled}
              title={choice.isDefault ? `${choice.label}, the book’s logo` : `Use ${choice.label} as the logo`}
              onClick={() => pick(choice.artifactId)}
            >
              {choice.url ? <img src={choice.url} alt="" draggable={false} /> : <ImageIcon size={18} />}
              {choice.isDefault && <Star size={10} className="graphics-logo-tile-star" />}
            </LogoTile>
          ))}
          <LogoTile
            label="Image…"
            expanded={picking}
            disabled={disabled || imageChoices.length === 0}
            title={imageChoices.length === 0 ? 'Add an image cell to the book first.' : 'Choose another image from the book'}
            onClick={() => setPicking((open) => !open)}
          >
            <Plus size={18} />
          </LogoTile>
        </div>
        <CornerPicker corner={layer ? graphicsLogoCorner(layer.position) : null} disabled={disabled || layer === null} onPick={place} />
      </div>
      {picking && <LogoPicker choices={imageChoices} current={layer?.artifactId ?? null} disabled={disabled} onPick={pick} onCancel={() => setPicking(false)} />}
      <div className="graphics-logo-ranges">
        <Range label="Logo size" value={layer?.size ?? read.logo?.size ?? DEFAULT_GRAPHICS_LOGO_SIZE} min={0.02} max={0.5} step={0.005}
          format={graphicsPercent} disabled={disabled || layer === null} onChange={setSize} />
        <Range label="Logo opacity" value={layer?.opacity ?? read.logo?.opacity ?? DEFAULT_GRAPHICS_LOGO_OPACITY} min={0.05} max={1} step={0.01}
          format={graphicsPercent} disabled={disabled || layer === null} onChange={setOpacity} />
      </div>
      <LogoDefault layer={layer} logo={read.logo} bookName={bookName} disabled={disabled} onSetDefault={onSetDefault} />
    </section>
  )
}

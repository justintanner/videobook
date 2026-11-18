import { useRef, useState, type DragEvent } from 'react'
import { ImagePlus, X } from 'lucide-react'
import { SOURCE_IMAGE_LIMIT, type GoalShortImageRef } from '../../../server/src/goal-short-plan'
import { activeCellRefDrag, isCellRefDragEvent } from '@/videobook/cell-ref-drag'
import { dataTransferHasFiles, mediaFileAccept, mediaKindForFile } from '@/videobook/notebook-media-drop'
import { GoalMedia } from './GoalStillCard'
import type { GoalStageContext } from './GoalStageParts'

export type CharacterImage = Omit<GoalShortImageRef, 'slot'>
export type CharacterSource = Pick<CharacterImage, 'cellId' | 'artifactId'>
export type CharacterInputs = {
  images: CharacterImage[]
  importFiles: (files: File[], add: (image: CharacterSource) => void) => Promise<void>
}

type Props = {
  ctx: GoalStageContext
  inputs: CharacterInputs
  selected: CharacterSource[]
  disabled: boolean
  onAdd: (image: CharacterSource) => void
  onRemove: (index: number) => void
  onRun: (work: () => Promise<unknown>) => void
}

export function GoalCharacterReferences({ ctx, inputs, selected, disabled, onAdd, onRemove, onRun }: Props) {
  const picker = useRef<HTMLInputElement>(null)
  const [hover, setHover] = useState(false)
  const [message, setMessage] = useState('')
  const full = selected.length >= SOURCE_IMAGE_LIMIT
  const scene = ctx.plan.version === 5 ? ctx.plan.remix?.frame.artifactId : null
  const taken = (id: string) => selected.some(source => source.artifactId === id)
  const available = inputs.images.filter(image => image.artifactId !== scene && !taken(image.artifactId))
  const add = (cellId: string) => {
    const image = inputs.images.find(image => image.cellId === cellId)
    if (!image || image.artifactId === scene) return setMessage('Choose a notebook image of a character.')
    if (taken(image.artifactId)) return setMessage('That image is already attached.')
    if (full) return setMessage(`A goal takes up to ${SOURCE_IMAGE_LIMIT} character images.`)
    setMessage('')
    onAdd(image)
  }
  const importFiles = (files: File[]) => {
    if (!files.length) return
    if (files.some(file => mediaKindForFile(file) !== 'image')) return setMessage('Choose image files for the characters.')
    if (selected.length + files.length > SOURCE_IMAGE_LIMIT) return setMessage(`A goal takes up to ${SOURCE_IMAGE_LIMIT} character images.`)
    setMessage('')
    onRun(() => inputs.importFiles(files, image => {
      if (image.artifactId === scene || taken(image.artifactId)) setMessage('That image is already attached.')
      else onAdd(image)
    }))
  }
  const accepted = (event: DragEvent<HTMLElement>) => isCellRefDragEvent(event) || dataTransferHasFiles(event.dataTransfer)
  return <section className="goal-character-refs" aria-label="Character references" data-hover={hover || undefined}
    onDragOver={event => {
      if (!accepted(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = disabled || full ? 'none' : 'copy'
      setHover(!disabled && !full)
    }}
    onDragLeave={event => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setHover(false) }}
    onDrop={event => {
      if (!accepted(event)) return
      event.preventDefault()
      event.stopPropagation()
      setHover(false)
      if (disabled) return
      const drag = activeCellRefDrag(event)
      if (drag) add(drag.sourceCellId)
      else importFiles([...event.dataTransfer.files])
    }}>
    <strong>Character references</strong>
    <div className="goal-reference-grid">
      {selected.map((source, index) => {
        const ref = inputs.images.find(ref => ref.cellId === source.cellId) ?? (ctx.plan.version === 5 ? ctx.plan.sourceImages.find(ref => ref.cellId === source.cellId) : undefined)
        const label = `@image${index + 1}`
        return <div className="goal-character-ref" key={source.artifactId}>
          <GoalMedia {...source} label={`${label} · ${ref?.address ?? 'Loading'}`} resolveAsset={ctx.resolveAsset} onOpen={ctx.onPreviewCell} />
          <button type="button" className="goal-character-remove" aria-label={`Remove ${label}`} disabled={disabled} onClick={() => { setMessage(''); onRemove(index) }}><X size={12} /></button>
        </div>
      })}
    </div>
    <button type="button" className="goal-character-drop" disabled={disabled || full} onClick={() => picker.current?.click()}>
      <ImagePlus size={17} aria-hidden="true" />{full ? `${SOURCE_IMAGE_LIMIT} images attached` : 'Drop images here or browse files'}
    </button>
    <input type="file" ref={picker} hidden accept={mediaFileAccept.image} multiple disabled={disabled || full} onChange={event => {
      const files = [...event.target.files ?? []]
      event.target.value = ''
      importFiles(files)
    }} />
    <select aria-label="Add a notebook image" value="" disabled={disabled || full || !available.length} onChange={event => add(event.target.value)}>
      <option value="">Add a notebook image…</option>
      {available.map(image => <option key={image.cellId} value={image.cellId}>{image.address} · {image.label}</option>)}
    </select>
    {message && <p role="status" className="goal-panel-warning">{message}</p>}
  </section>
}

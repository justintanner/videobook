import { Film, Image, LoaderCircle, Upload, X } from 'lucide-react'
import type { ClipboardEvent, DragEvent, ReactNode } from 'react'
import {
  compatibleReferenceFile,
  referenceKind,
  type ReverseSearchMode,
  type SearchReferenceDescriptor,
} from '@/videobook/search-reference'

interface ReverseSearchReferenceProps {
  mode: ReverseSearchMode
  reference: SearchReferenceDescriptor | null
  preparing: boolean
  disabled: boolean
  startSeconds: string
  durationSeconds: string
  children?: ReactNode
  onFile: (file: File) => void
  onClear: () => void
  onStartSeconds: (value: string) => void
  onDurationSeconds: (value: string) => void
}

export function ReverseSearchReference({
  mode,
  reference,
  preparing,
  disabled,
  startSeconds,
  durationSeconds,
  children,
  onFile,
  onClear,
  onStartSeconds,
  onDurationSeconds,
}: ReverseSearchReferenceProps) {
  const kind = referenceKind(mode)
  const noun = kind === 'image' ? 'an image' : 'a video'
  const Icon = kind === 'image' ? Image : Film
  const accept = kind === 'image' ? 'image/*' : 'video/*'
  const receiveFiles = (files: File[]) => {
    if (disabled || preparing) return
    const file = files.find((candidate) =>
      compatibleReferenceFile(candidate, kind))
    if (file) onFile(file)
  }
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    receiveFiles([...event.dataTransfer.files])
  }
  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const clipboardFiles = [...event.clipboardData.files]
    const files = clipboardFiles.length > 0
      ? clipboardFiles
      : [...event.clipboardData.items].flatMap((item) => {
          const file = item.kind === 'file' ? item.getAsFile() : null
          return file ? [file] : []
        })
    if (!files.some((file) => compatibleReferenceFile(file, kind))) return
    event.preventDefault()
    event.stopPropagation()
    receiveFiles(files)
  }

  return (
    <section
      className="reverse-search-reference"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault()
      }}
      onDrop={handleDrop}
      onPaste={handlePaste}
    >
      <div className="reverse-search-dropzone" tabIndex={0} autoFocus>
        {preparing ? (
          <LoaderCircle size={24} className="spin" />
        ) : reference?.previewUrl ? (
          kind === 'image' ? (
            <img src={reference.previewUrl} alt="" />
          ) : (
            <video src={reference.previewUrl} controls playsInline preload="metadata" />
          )
        ) : (
          <Icon size={26} />
        )}
        <div>
          <strong>
            {preparing
              ? `Preparing ${kind}…`
              : reference
                ? reference.name
                : `Drop or paste ${noun}`}
          </strong>
          <span>
            {reference
              ? 'Temporary search reference'
              : `Choose ${noun} file, drag it here, or paste from the clipboard`}
          </span>
        </div>
        <label className="reverse-search-upload">
          <Upload size={14} />Choose file
          <input
            type="file"
            accept={accept}
            disabled={disabled || preparing}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) onFile(file)
              event.target.value = ''
            }}
          />
        </label>
        {reference && (
          <button
            type="button"
            className="reverse-search-clear"
            disabled={disabled || preparing}
            aria-label="Clear search reference"
            onClick={onClear}
          >
            <X size={14} />Clear
          </button>
        )}
      </div>
      {children}
      {kind === 'video' && reference && (
        <div className="reverse-search-range">
          <label>
            Start seconds
            <input
              type="number"
              min="0"
              step="0.1"
              value={startSeconds}
              onChange={(event) => onStartSeconds(event.target.value)}
            />
          </label>
          <label>
            Duration seconds
            <input
              type="number"
              min="0.1"
              step="0.1"
              value={durationSeconds}
              placeholder="Whole remaining video"
              onChange={(event) => onDurationSeconds(event.target.value)}
            />
          </label>
          {reference.durationMs !== undefined && (
            <span>{(reference.durationMs / 1_000).toFixed(1)}s available</span>
          )}
        </div>
      )}
    </section>
  )
}

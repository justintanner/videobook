import { useState } from 'react'
import type { FormEvent } from 'react'
import { Download, Library, Plus } from 'lucide-react'

type NotebookStartMediaType = 'image' | 'video'

type NotebookStartDockProps = {
  busy: boolean
  onAdd: (type: NotebookStartMediaType) => void | Promise<void>
  onDownload: (url: string) => Promise<void>
  onOpenLibrary: () => void
}

export function NotebookStartDock({ busy, onAdd, onDownload, onOpenLibrary }: NotebookStartDockProps) {
  const [url, setUrl] = useState('')
  const [downloading, setDownloading] = useState(false)
  const trimmedUrl = url.trim()
  const disabled = busy || downloading

  const submitDownload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (disabled || !trimmedUrl) return
    setDownloading(true)
    try {
      await onDownload(trimmedUrl)
      setUrl('')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <aside className="canvas-start-dock" aria-label="Start this notebook">
      <div className="canvas-start-dock-copy">
        <span>Empty notebook</span>
        <strong>Drop a picture, video or audio file on any square, or start with:</strong>
      </div>
      <div className="canvas-start-dock-actions" role="group" aria-label="Ways to add media">
        <button
          type="button"
          className="canvas-start-dock-action canvas-start-dock-primary"
          title="Add an image cell and pick from recent media"
          aria-label="Start with an image"
          disabled={disabled}
          onClick={() => void onAdd('image')}
        >
          <Plus size={14} />
          <span>Image</span>
        </button>
        <button
          type="button"
          className="canvas-start-dock-action canvas-start-dock-primary"
          title="Add a video cell and pick from recent media"
          aria-label="Start with a video"
          disabled={disabled}
          onClick={() => void onAdd('video')}
        >
          <Plus size={14} />
          <span>Video</span>
        </button>
        <form className="canvas-start-dock-form" onSubmit={(event) => void submitDownload(event)}>
          <input
            type="url"
            inputMode="url"
            aria-label="Clip link"
            placeholder="Paste a YouTube, X or TikTok link"
            value={url}
            disabled={disabled}
            onChange={(event) => setUrl(event.target.value)}
          />
          <button
            type="submit"
            className="canvas-start-dock-action"
            title="Download the clip into this notebook"
            disabled={disabled || !trimmedUrl}
          >
            <Download size={14} />
            <span>{downloading ? 'Downloading…' : 'Download clip'}</span>
          </button>
        </form>
        <button
          type="button"
          className="canvas-start-dock-action"
          title="Browse images and videos from every book"
          disabled={busy}
          onClick={onOpenLibrary}
        >
          <Library size={14} />
          <span>Library</span>
        </button>
      </div>
    </aside>
  )
}

import { ImageIcon, LockKeyhole, MessageSquareText, Plus, Video } from 'lucide-react'
import type { NotebookStepType } from './types'

interface NotebookToolboxProps {
  onAdd: (type: Extract<NotebookStepType, 'prompt' | 'image' | 'video'>) => void
  onDragStart: (type: Extract<NotebookStepType, 'prompt' | 'image' | 'video'>) => void
  onDragEnd: () => void
}

const tools: Array<{ type: Extract<NotebookStepType, 'prompt' | 'image' | 'video'>; label: string; icon: typeof ImageIcon }> = [
  { type: 'prompt', label: 'Prompt', icon: MessageSquareText },
  { type: 'image', label: 'Image', icon: ImageIcon },
  { type: 'video', label: 'Video', icon: Video },
]

export function NotebookToolbox({ onAdd, onDragStart, onDragEnd }: NotebookToolboxProps) {
  return (
    <div className="vc-notebook-toolbox">
      <span className="vc-notebook-toolbox-title"><Plus /> Deploy</span>
      <div className="vc-notebook-toolbox-actions">
        {tools.map(({ type, label, icon: Icon }) => (
          <button
            key={type}
            type="button"
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData('application/x-videocity-notebook-step', type)
              event.dataTransfer.effectAllowed = 'copy'
              onDragStart(type)
            }}
            onDragEnd={onDragEnd}
            onClick={() => onAdd(type)}
          >
            <Icon /> {label}
          </button>
        ))}
      </div>
      <span className="vc-notebook-snap-lock"><LockKeyhole /> Snap locked</span>
    </div>
  )
}

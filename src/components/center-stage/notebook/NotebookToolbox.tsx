import { ImageIcon, MessageSquareText, Video } from 'lucide-react'
import type { NotebookStepType } from './types'

interface NotebookToolboxProps {
  onAdd: (type: Extract<NotebookStepType, 'prompt' | 'image' | 'video'>) => void
}

const tools: Array<{ type: Extract<NotebookStepType, 'prompt' | 'image' | 'video'>; label: string; icon: typeof ImageIcon }> = [
  { type: 'prompt', label: 'Prompt', icon: MessageSquareText },
  { type: 'image', label: 'Image', icon: ImageIcon },
  { type: 'video', label: 'Video', icon: Video },
]

export function NotebookToolbox({ onAdd }: NotebookToolboxProps) {
  return (
    <div className="vc-notebook-toolbox">
      {tools.map(({ type, label, icon: Icon }) => (
        <button
          key={type}
          type="button"
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData('application/x-videocity-notebook-step', type)
            event.dataTransfer.effectAllowed = 'copy'
          }}
          onClick={() => onAdd(type)}
        >
          <Icon /> {label}
        </button>
      ))}
    </div>
  )
}

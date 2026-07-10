import { useRootEditor } from 'sequential-workflow-designer-react'
import type { NotebookPlanDefinition } from './types'

export function NotebookRootEditor() {
  const editor = useRootEditor<NotebookPlanDefinition>()
  const title = typeof editor.properties.title === 'string' ? editor.properties.title : ''

  return (
    <div className="vc-notebook-root-editor">
      <label htmlFor="notebook-title">Plan title</label>
      <input
        id="notebook-title"
        value={title}
        onChange={(event) => editor.setProperty('title', event.target.value)}
        placeholder="Untitled Plan"
      />
      <p>Select a cell to edit it, or add a prompt, image, or video cell from the toolbox.</p>
    </div>
  )
}

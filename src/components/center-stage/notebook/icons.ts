import type { NotebookStepType } from './types'

function icon(fill: string, path: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${fill}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

const icons: Record<NotebookStepType, string> = {
  prompt: icon('#f59e0b', '<path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4V5Z"/><path d="M8 8h8M8 12h5"/>'),
  image: icon('#22d3ee', '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m21 15-4-4L5 20"/>'),
  video: icon('#a78bfa', '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3v-4Z"/>'),
}

export function notebookStepIcon(type: string): string | null {
  return type === 'prompt' || type === 'image' || type === 'video' ? icons[type] : null
}

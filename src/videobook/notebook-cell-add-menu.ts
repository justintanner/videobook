import type { NotebookCellType } from 'videobook-engine'

export const notebookCellAddGroups = [
  'Media',
  'Text & analysis',
  'Generation',
  'Edit',
] as const

type NotebookCellAddGroup = (typeof notebookCellAddGroups)[number]

type NotebookCellAddItemShape = {
  type: NotebookCellType
  label: string
  group: NotebookCellAddGroup
}

const notebookCellAddItems = [
  { type: 'audio', label: 'Audio', group: 'Media' },
  { type: 'image', label: 'Image', group: 'Media' },
  { type: 'video', label: 'Video', group: 'Media' },
  { type: 'character', label: 'Character', group: 'Media' },
  { type: 'prompt', label: 'Prompt', group: 'Text & analysis' },
  { type: 'analyze', label: 'Analyze', group: 'Text & analysis' },
  { type: 'generate_video', label: 'Generate video', group: 'Generation' },
  { type: 'generate_image', label: 'Generate image', group: 'Generation' },
  { type: 'generate_audio', label: 'Generate audio', group: 'Generation' },
  { type: 'extract_audio', label: 'Extract audio', group: 'Edit' },
  { type: 'split_video', label: 'Split video', group: 'Edit' },
  { type: 'concat', label: 'Concat', group: 'Edit' },
  { type: 'splice', label: 'Splice', group: 'Edit' },
] as const satisfies readonly NotebookCellAddItemShape[]

type NotebookCellAddItem = (typeof notebookCellAddItems)[number]
export type NotebookCellAddType = (typeof notebookCellAddItems)[number]['type']

const notebookCellAddTypes = new Set<string>(
  notebookCellAddItems.map((item) => item.type),
)

function normalizedSearchValue(value: string): string {
  return value.trim().toLocaleLowerCase().replaceAll('_', ' ')
}

export function filterNotebookCellAddItems(
  search: string,
): readonly NotebookCellAddItem[] {
  const query = normalizedSearchValue(search)
  if (!query) return notebookCellAddItems
  return notebookCellAddItems.filter((item) => normalizedSearchValue(
    `${item.label} ${item.type} ${item.group}`,
  ).includes(query))
}

export function isNotebookCellAddType(value: string): value is NotebookCellAddType {
  return notebookCellAddTypes.has(value)
}

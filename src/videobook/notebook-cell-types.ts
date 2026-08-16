import type { NotebookCellType } from 'videobook-engine'

export type NotebookGenerationCellType =
  | 'generate_audio'
  | 'generate_image'
  | 'generate_video'

export type NotebookExtractMediaCellType =
  | 'extract_audio'
  | 'extract_frame'

export type NotebookMediaPresentationCellType =
  | 'audio'
  | 'character'
  | 'image'
  | 'video'

export type NotebookMediaWorkCellType =
  | 'audio'
  | 'image'
  | 'video'

const generationCellTypes = new Set<string>([
  'generate_audio',
  'generate_image',
  'generate_video',
] satisfies NotebookCellType[])

const extractMediaCellTypes = new Set<string>([
  'extract_audio',
  'extract_frame',
] satisfies NotebookCellType[])

const mediaWorkCellTypeValues = [
  'audio',
  'image',
  'video',
] satisfies NotebookCellType[]

const mediaPresentationCellTypes = new Set<string>([
  ...mediaWorkCellTypeValues,
  'character',
] satisfies NotebookCellType[])

const mediaWorkCellTypes = new Set<string>(mediaWorkCellTypeValues)

export function isNotebookGenerationCellType(
  type: string,
): type is NotebookGenerationCellType {
  return generationCellTypes.has(type)
}

export function isNotebookExtractMediaCellType(
  type: string,
): type is NotebookExtractMediaCellType {
  return extractMediaCellTypes.has(type)
}

export function isNotebookMediaPresentationCellType(
  type: string,
): type is NotebookMediaPresentationCellType {
  return mediaPresentationCellTypes.has(type)
}

export function isNotebookMediaWorkCellType(
  type: string,
): type is NotebookMediaWorkCellType {
  return mediaWorkCellTypes.has(type)
}
